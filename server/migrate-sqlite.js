import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, withTransaction } from "./database.js";
import { loadConfig } from "./config.js";

const serverDirectory = dirname(fileURLToPath(import.meta.url));

function readTable(source, table) {
  const found = source.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
  if (!found) return [];
  return source.prepare(`SELECT * FROM "${table}"`).all();
}

function asBoolean(value) {
  return value === true || value === 1;
}

function subjectKey(schoolId, subject) {
  return `${schoolId}:${subject.trim().toLowerCase()}`;
}

function subjectId(schoolId, subject) {
  const key = `${schoolId}:${subject.trim().toLowerCase()}`;
  return `subject-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export async function migrateSqliteData(sourcePath, pool) {
  if (!existsSync(sourcePath)) throw new Error(`SQLite source file not found: ${sourcePath}`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const tables = {
      schools: readTable(source, "schools"),
      users: readTable(source, "users"),
      sessions: readTable(source, "sessions"),
      teacherProfiles: readTable(source, "teacher_profiles"),
      teacherClasses: readTable(source, "teacher_classes"),
      classMembers: readTable(source, "class_members"),
      exams: readTable(source, "exam"),
      examQuestions: readTable(source, "exam_questions"),
      examOptions: readTable(source, "exam_options"),
      attempts: readTable(source, "exam_attempts"),
      answers: readTable(source, "exam_answers"),
      results: readTable(source, "exam_results"),
      teacherSettings: readTable(source, "teacher_exam_settings"),
      examClasses: readTable(source, "exam_classes"),
      analytics: readTable(source, "exam_question_analytics"),
    };
    const { rows: [migration] } = await pool.query(
      "SELECT MAX(version)::INTEGER AS version FROM schema_migrations",
    );
    if ((migration.version ?? 0) < 2) {
      throw new Error("Run `npm run migrate` before migrating SQLite data.");
    }

    const examSettings = new Map(tables.teacherSettings.map((row) => [row.exam_id, row]));
    const exams = tables.exams.map((row) => ({
      ...row,
      school_id: row.school_id ?? examSettings.get(row.id)?.school_id ?? null,
    }));
    const sourceSchoolIds = new Set([
      ...tables.schools.map((row) => row.id),
      ...tables.users.map((row) => row.school_id).filter(Boolean),
      ...tables.teacherProfiles.map((row) => row.school_id).filter(Boolean),
      ...tables.teacherClasses.map((row) => row.school_id).filter(Boolean),
      ...tables.teacherSettings.map((row) => row.school_id).filter(Boolean),
      ...exams.map((row) => row.school_id).filter(Boolean),
    ]);
    const schoolsById = new Map(tables.schools.map((row) => [row.id, row]));
    const schoolNames = new Map(tables.schools.map((row) => [row.id, row.name]));
    const subjects = new Map();
    for (const row of [...tables.teacherProfiles, ...exams]) {
      if (row.school_id && row.subject) {
        subjects.set(subjectKey(row.school_id, row.subject), {
          id: subjectId(row.school_id, row.subject),
          schoolId: row.school_id,
          name: row.subject,
        });
      }
    }
    const classSchool = new Map(tables.teacherClasses.map((row) => [row.id, row.school_id]));
    const examSchool = new Map(exams.map((row) => [row.id, row.school_id]));

    await withTransaction(pool, async (client) => {
      for (const schoolId of sourceSchoolIds) {
        const sourceSchool = schoolsById.get(schoolId);
        await client.query(`
          INSERT INTO schools (id, name, created_at)
          VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING
        `, [
          schoolId,
          sourceSchool?.name ?? schoolNames.get(schoolId) ?? schoolId,
          sourceSchool?.created_at ?? new Date(),
        ]);
      }
      for (const subject of subjects.values()) {
        await client.query(`
          INSERT INTO subjects (id, school_id, name)
          VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING
        `, [subject.id, subject.schoolId, subject.name]);
      }
      for (const row of tables.users) {
        const email = String(row.email).trim().toLowerCase();
        await client.query(`
          INSERT INTO users (id, full_name, email, password_salt, password_hash,
            created_at, role, school_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.full_name, email, row.password_salt, row.password_hash,
          row.created_at, row.role ?? "student", row.school_id ?? null,
        ]);
      }
      for (const row of tables.teacherProfiles) {
        const id = subjectId(row.school_id, row.subject);
        await client.query(`
          INSERT INTO teachers (id, user_id, full_name, school_id, subject_id, subject, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.user_id, row.full_name, row.school_id, id, row.subject, row.created_at,
        ]);
      }
      for (const row of tables.teacherClasses) {
        await client.query(`
          INSERT INTO classes (id, school_id, name, grade_level, program, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.school_id, row.name, row.grade_level, row.program, row.created_at ?? new Date(),
        ]);
      }
      for (const row of tables.sessions) {
        await client.query(`
          INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
          VALUES ($1, $2, $3, $4) ON CONFLICT (token_hash) DO NOTHING
        `, [row.token_hash, row.user_id, row.expires_at, row.created_at]);
      }
      for (const row of exams) {
        await client.query(`
          INSERT INTO exams (id, school_id, subject_id, title, subject, teacher_name, code, description,
            status, duration_minutes, opens_at, closes_at, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.school_id,
          row.school_id ? subjectId(row.school_id, row.subject) : null,
          row.title, row.subject, row.teacher_name, row.code, row.description,
          row.status, row.duration_minutes, row.opens_at, row.closes_at, row.created_at,
        ]);
      }
      for (const row of tables.teacherSettings) {
        await client.query(`
          INSERT INTO teacher_exam_settings (exam_id, teacher_id, school_id, academic_year,
            semester, grade_level, mc_question_count, essay_question_count,
            randomize_questions, randomize_options, workflow_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (exam_id) DO NOTHING
        `, [
          row.exam_id, row.teacher_id, row.school_id, row.academic_year, row.semester,
          row.grade_level, row.mc_question_count, row.essay_question_count,
          asBoolean(row.randomize_questions), asBoolean(row.randomize_options), row.workflow_status,
        ]);
      }
      for (const row of tables.examQuestions) {
        await client.query(`
          INSERT INTO exam_questions (
            id, exam_id, position, prompt, type, points, answer_key,
            requires_manual_grading, school_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.exam_id, row.position, row.prompt, row.type,
          row.points ?? 1, row.answer_key ?? "",
          asBoolean(row.requires_manual_grading),
          row.school_id ?? examSchool.get(row.exam_id) ?? null,
        ]);
      }
      for (const row of tables.examOptions) {
        await client.query(`
          INSERT INTO exam_options (id, question_id, position, label, content, is_correct)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.question_id, row.position, row.label, row.content, asBoolean(row.is_correct),
        ]);
      }

      const usersById = new Map(tables.users.map((row) => [row.id, row]));
      for (const row of tables.classMembers) {
        const schoolId = classSchool.get(row.class_id);
        if (!schoolId) throw new Error(`Class ${row.class_id} has no school in SQLite data.`);
        await client.query(
          "UPDATE users SET school_id = $1 WHERE id = $2 AND school_id IS NULL",
          [schoolId, row.student_user_id],
        );
        const student = usersById.get(row.student_user_id);
        if (student?.role === "student") {
          await client.query(`
            INSERT INTO students (user_id, school_id, created_at)
            VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING
          `, [row.student_user_id, schoolId, student.created_at]);
          await client.query(`
            INSERT INTO class_members (class_id, student_user_id, school_id, assigned_at)
            VALUES ($1, $2, $3, $4) ON CONFLICT (student_user_id) DO NOTHING
          `, [row.class_id, row.student_user_id, schoolId, row.assigned_at]);
        }
      }
      for (const row of tables.examClasses) {
        const schoolId = row.school_id ?? examSchool.get(row.exam_id);
        await client.query(`
          INSERT INTO exam_classes (exam_id, class_id, school_id)
          VALUES ($1, $2, $3) ON CONFLICT (exam_id, class_id) DO NOTHING
        `, [row.exam_id, row.class_id, schoolId]);
      }
      for (const row of tables.attempts) {
        await client.query(`
          INSERT INTO exam_attempts (id, user_id, exam_id, school_id, status,
            started_at, expires_at, submitted_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.user_id, row.exam_id, examSchool.get(row.exam_id) ?? null,
          row.status, row.started_at, row.expires_at, row.submitted_at ?? null,
        ]);
      }
      for (const row of tables.answers) {
        await client.query(`
          INSERT INTO exam_answers (id, attempt_id, question_id, selected_option_id, answer_text, answered_at)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.attempt_id, row.question_id, row.selected_option_id ?? null,
          row.answer_text ?? null, row.answered_at,
        ]);
      }
      for (const row of tables.results) {
        await client.query(`
          INSERT INTO exam_results (id, attempt_id, user_id, exam_id, school_id,
            score, correct_count, wrong_count, unanswered_count, duration_seconds, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO NOTHING
        `, [
          row.id, row.attempt_id, row.user_id, row.exam_id, examSchool.get(row.exam_id) ?? null,
          row.score, row.correct_count, row.wrong_count, row.unanswered_count,
          row.duration_seconds, row.created_at,
        ]);
      }
      for (const row of tables.analytics) {
        await client.query(`
          INSERT INTO exam_question_analytics (exam_question_id, average_score, correct_rate, response_count)
          VALUES ($1, $2, $3, $4) ON CONFLICT (exam_question_id) DO NOTHING
        `, [row.exam_question_id, row.average_score, row.correct_rate, row.response_count]);
      }
    });
    return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
  } finally {
    source.close();
  }
}

async function main() {
  const config = loadConfig();
  const sourcePath = resolve(
    process.argv[2] ?? process.env.SQLITE_SOURCE ?? resolve(serverDirectory, "data/student.sqlite"),
  );
  const database = createDatabase(config.database);
  try {
    const counts = await migrateSqliteData(sourcePath, database);
    console.log("SQLite data imported into PostgreSQL:", counts);
  } finally {
    await database.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
