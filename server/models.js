import { createHash, randomUUID } from "node:crypto";
import { withTransaction } from "./database.js";

function mapExam(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    teacherName: row.teacher_name,
    code: row.code,
    description: row.description,
    status: row.status,
    requiresToken: Boolean(row.requires_token),
    durationMinutes: Number(row.duration_minutes),
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    questionCount: Number(row.question_count),
    kkm: Number(row.kkm ?? 75),
  };
}

function mapAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    violationCount: Number(row.violation_count ?? 0),
    lockedUntil: row.locked_until,
    disqualifiedAt: row.disqualified_at,
  };
}

function mapResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    attemptId: row.attempt_id,
    examId: row.exam_id,
    examTitle: row.exam_title,
    subject: row.subject,
    code: row.code,
    score: Number(row.score),
    correctCount: Number(row.correct_count),
    wrongCount: Number(row.wrong_count),
    unansweredCount: Number(row.unanswered_count),
    durationSeconds: Number(row.duration_seconds),
    createdAt: row.created_at,
    kkm: Number(row.kkm ?? 75),
    passed: Number(row.score) >= Number(row.kkm ?? 75),
    remedialStatus: row.remedial_status ?? null,
  };
}

export function createStudentModel(database) {
  const examQuery = `
    SELECT e.*, COUNT(q.id)::INTEGER AS question_count,
      EXISTS (SELECT 1 FROM teacher_exam_settings tes WHERE tes.exam_id = e.id) AS requires_token,
      (SELECT kkm FROM teacher_exam_settings tes WHERE tes.exam_id = e.id) AS kkm
    FROM exams e
    LEFT JOIN exam_questions q ON q.exam_id = e.id
    WHERE e.id = $1
    GROUP BY e.id
  `;
  const resultQuery = `
    SELECT r.*, e.title AS exam_title, e.subject, e.code,
      tes.kkm,
      (SELECT status FROM remedial_requests rr WHERE rr.result_id = r.id) AS remedial_status
    FROM exam_results r
    JOIN exams e ON e.id = r.exam_id
    LEFT JOIN teacher_exam_settings tes ON tes.exam_id = e.id
    WHERE r.id = $1 AND r.user_id = $2
  `;

  return {
    async getRegistrationOptions(requestedSchoolId) {
      const { rows: schools } = await database.query(`
        SELECT id, name FROM schools
        WHERE is_active = TRUE
        ORDER BY name
      `);
      const school = schools.find((item) => item.id === requestedSchoolId) ??
        (requestedSchoolId ? null : schools[0] ?? null);
      if (!school) return { schools, school: null, classes: [] };
      const { rows: classes } = await database.query(`
        SELECT id, name, grade_level AS "gradeLevel", program
        FROM classes
        WHERE school_id = $1
        ORDER BY
          CASE grade_level WHEN 'X' THEN 1 WHEN 'XI' THEN 2 WHEN 'XII' THEN 3 ELSE 4 END,
          CASE
            WHEN name ~ ' [0-9]+$'
            THEN CAST(substring(name from '[0-9]+$') AS INTEGER)
            ELSE 999
          END,
          name
      `, [school.id]);
      return { schools, school, classes };
    },
    async createUser({ id, fullName, email, passwordSalt, passwordHash, createdAt, schoolId, classId }) {
      await withTransaction(database, async (client) => {
        const { rows: [school] } = await client.query(
          "SELECT id FROM schools WHERE id = $1 AND is_active = TRUE",
          [schoolId],
        );
        if (!school) throw new Error("REGISTRATION_SCHOOL_INACTIVE");
        const { rows: [schoolClass] } = await client.query(`
          SELECT id FROM classes WHERE id = $1 AND school_id = $2
        `, [classId, schoolId]);
        if (!schoolClass) throw new Error("REGISTRATION_CLASS_INVALID");
        await client.query(`
          INSERT INTO users (
            id, full_name, email, password_salt, password_hash, created_at, role, school_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'student', $7)
        `, [id, fullName, email, passwordSalt, passwordHash, createdAt, schoolId ?? null]);
        await client.query(`
          INSERT INTO students (user_id, school_id, created_at)
          VALUES ($1, $2, $3)
        `, [id, schoolId, createdAt]);
        await client.query(`
          INSERT INTO class_members (class_id, student_user_id, school_id, assigned_at)
          VALUES ($1, $2, $3, $4)
        `, [classId, id, schoolId, createdAt]);
      });
      return this.findUserById(id);
    },
    async findUserByEmail(email) {
      const { rows: [row] } = await database.query(
        `SELECT u.*, s.name AS school_name, s.is_active AS school_is_active,
          c.name AS class_name
        FROM users u LEFT JOIN schools s ON s.id = u.school_id
        LEFT JOIN class_members cm ON cm.student_user_id = u.id
        LEFT JOIN classes c ON c.id = cm.class_id
        WHERE lower(u.email) = $1`,
        [email],
      );
      return row ? {
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        role: row.role,
        schoolId: row.school_id,
        schoolName: row.school_name,
        schoolIsActive: row.school_is_active,
        className: row.class_name,
        isActive: row.is_active,
        passwordSalt: row.password_salt,
        passwordHash: row.password_hash,
      } : null;
    },
    async findUserById(id) {
      const { rows: [row] } = await database.query(
        `SELECT u.id, u.full_name, u.email, u.role, u.school_id, s.name AS school_name,
          c.name AS class_name, u.created_at, u.is_active
        FROM users u LEFT JOIN schools s ON s.id = u.school_id
        LEFT JOIN class_members cm ON cm.student_user_id = u.id
        LEFT JOIN classes c ON c.id = cm.class_id WHERE u.id = $1`,
        [id],
      );
      return row ? {
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        role: row.role,
        schoolId: row.school_id,
        schoolName: row.school_name,
        className: row.class_name,
        createdAt: row.created_at,
        isActive: row.is_active,
      } : null;
    },
    async getStudentProfile(userId) {
      const { rows: [row] } = await database.query(`
        SELECT u.id, u.full_name AS "fullName", u.email, u.role,
          u.created_at AS "createdAt", u.is_active AS "isActive",
          u.school_id AS "schoolId", school.name AS "schoolName",
          c.id AS "classId", c.name AS "className"
        FROM users u
        LEFT JOIN schools school ON school.id = u.school_id
        LEFT JOIN class_members cm ON cm.student_user_id = u.id
        LEFT JOIN classes c ON c.id = cm.class_id
        WHERE u.id = $1 AND u.role = 'student'
      `, [userId]);
      return row ?? null;
    },
    async updateStudentProfile(userId, { fullName, email, passwordSalt, passwordHash }) {
      const { rows: [row] } = await database.query(`
        UPDATE users
        SET full_name = $2, email = $3,
          password_salt = COALESCE($4, password_salt),
          password_hash = COALESCE($5, password_hash)
        WHERE id = $1 AND role = 'student'
        RETURNING id
      `, [userId, fullName, email, passwordSalt ?? null, passwordHash ?? null]);
      return row ? this.getStudentProfile(userId) : null;
    },
    async createSession({ tokenHash, userId, expiresAt, createdAt }) {
      await database.query(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES ($1, $2, $3, $4)
      `, [tokenHash, userId, expiresAt, createdAt]);
    },
    async findUserBySession(tokenHash, now) {
      const { rows: [row] } = await database.query(`
        SELECT u.id, u.full_name, u.email, u.role, u.school_id,
          school.name AS school_name, c.name AS class_name,
          u.created_at, u.is_active
        FROM sessions s JOIN users u ON u.id = s.user_id
        LEFT JOIN schools school ON school.id = u.school_id
        LEFT JOIN class_members cm ON cm.student_user_id = u.id
        LEFT JOIN classes c ON c.id = cm.class_id
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.is_active = TRUE
          AND (u.school_id IS NULL OR school.is_active = TRUE)
      `, [tokenHash, now]);
      return row ? {
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        role: row.role,
        schoolId: row.school_id,
        schoolName: row.school_name,
        className: row.class_name,
        createdAt: row.created_at,
        isActive: row.is_active,
      } : null;
    },
    async deleteSession(tokenHash) {
      await database.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    },
    async listExams(userId) {
      const { rows } = await database.query(`
        SELECT e.*, COUNT(q.id)::INTEGER AS question_count,
          EXISTS (SELECT 1 FROM teacher_exam_settings tes WHERE tes.exam_id = e.id) AS requires_token,
          (SELECT kkm FROM teacher_exam_settings tes WHERE tes.exam_id = e.id) AS kkm
        FROM exams e
        LEFT JOIN exam_questions q ON q.exam_id = e.id
        WHERE EXISTS (
          SELECT 1
          FROM teacher_exam_settings tes
          JOIN exam_classes ec ON ec.exam_id = tes.exam_id
          JOIN class_members cm ON cm.class_id = ec.class_id
          WHERE tes.exam_id = e.id
            AND tes.workflow_status <> 'draft'
            AND cm.student_user_id = $1
            AND ec.school_id = (SELECT school_id FROM users WHERE id = $1)
        )
        GROUP BY e.id
        ORDER BY e.opens_at ASC
      `, [userId]);
      return Promise.all(rows.map(async (row) => {
        const { rows: [attempt] } = await database.query(`
          SELECT id, status, started_at, expires_at, violation_count, locked_until, disqualified_at
          FROM exam_attempts
          WHERE user_id = $1 AND exam_id = $2 AND status = 'in_progress'
          ORDER BY started_at DESC LIMIT 1
        `, [userId, row.id]);
        return { ...mapExam(row), activeAttempt: mapAttempt(attempt) };
      }));
    },
    async getExam(id, userId) {
      const { rows: [classAssignment] } = await database.query(`
        SELECT 1
        FROM teacher_exam_settings tes
        JOIN exam_classes ec ON ec.exam_id = tes.exam_id
        JOIN class_members cm ON cm.class_id = ec.class_id
        WHERE tes.exam_id = $1
          AND tes.workflow_status <> 'draft'
          AND cm.student_user_id = $2
          AND ec.school_id = (SELECT school_id FROM users WHERE id = $2)
      `, [id, userId]);
      if (!classAssignment) return null;
      const { rows: [examRow] } = await database.query(examQuery, [id]);
      const exam = mapExam(examRow);
      if (!exam) return null;
      const { rows: [attempt] } = await database.query(`
        SELECT id, status, started_at, expires_at, violation_count, locked_until, disqualified_at
        FROM exam_attempts
        WHERE user_id = $1 AND exam_id = $2 AND status = 'in_progress'
        ORDER BY started_at DESC LIMIT 1
      `, [userId, id]);
      return { ...exam, activeAttempt: mapAttempt(attempt) };
    },
    async getQuestionRows(examId, attemptId, userId) {
      const { rows: [attempt] } = await database.query(`
        SELECT id FROM exam_attempts
        WHERE id = $1 AND exam_id = $2 AND user_id = $3 AND status = 'in_progress'
          AND disqualified_at IS NULL
          AND (locked_until IS NULL OR locked_until <= NOW())
      `, [attemptId, examId, userId]);
      if (!attempt) return null;

      const { rows: questions } = await database.query(`
        SELECT q.id, q.position, q.prompt, q.type, a.selected_option_id
        FROM exam_questions q
        LEFT JOIN exam_answers a
          ON a.question_id = q.id AND a.attempt_id = $1
        WHERE q.exam_id = $2
        ORDER BY q.position
      `, [attemptId, examId]);
      const { rows: optionRows } = await database.query(`
        SELECT id, question_id, position, label, content
        FROM exam_options
        WHERE question_id = ANY($1::text[])
        ORDER BY position
      `, [questions.map((question) => question.id)]);
      const { rows: [randomization] } = await database.query(`
        SELECT randomize_questions, randomize_options
        FROM teacher_exam_settings WHERE exam_id = $1
      `, [examId]);

      function stableSort(items, seed, getId) {
        return items.sort((left, right) => {
          const leftKey = createHash("sha256").update(`${seed}:${getId(left)}`).digest("hex");
          const rightKey = createHash("sha256").update(`${seed}:${getId(right)}`).digest("hex");
          return leftKey.localeCompare(rightKey);
        });
      }
      if (randomization?.randomize_questions) {
        stableSort(questions, attemptId, (question) => question.id);
      }
      const optionsByQuestion = new Map();
      for (const option of optionRows) {
        const options = optionsByQuestion.get(option.question_id) ?? [];
        options.push(option);
        optionsByQuestion.set(option.question_id, options);
      }
      return questions.map((question, index) => {
        const questionOptions = optionsByQuestion.get(question.id) ?? [];
        const orderedOptions = randomization?.randomize_options && question.type !== "matching"
          ? stableSort(questionOptions, attemptId, (option) => `${question.id}:${option.id}`)
          : questionOptions;
        return {
          id: question.id,
          number: index + 1,
          prompt: question.prompt,
          type: question.type,
          selectedOptionId: question.selected_option_id,
          options: orderedOptions.map(({ id, label, content }) => ({ id, label, content })),
        };
      });
    },
    async saveAnswer({ attemptId, examId, userId, questionId, optionId, answeredAt }) {
      const { rows: [question] } = await database.query(`
        SELECT q.id
        FROM exam_questions q
        JOIN exam_attempts a ON a.exam_id = q.exam_id
        WHERE q.id = $1 AND a.id = $2 AND a.user_id = $3 AND a.status = 'in_progress'
          AND a.disqualified_at IS NULL
          AND (a.locked_until IS NULL OR a.locked_until <= NOW())
      `, [questionId, attemptId, userId]);
      if (!question) return false;
      if (optionId !== null) {
        const { rows: [option] } = await database.query(
          "SELECT id FROM exam_options WHERE id = $1 AND question_id = $2",
          [optionId, questionId],
        );
        if (!option) return false;
      }
      await database.query(`
        INSERT INTO exam_answers (id, attempt_id, question_id, selected_option_id, answered_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET selected_option_id = EXCLUDED.selected_option_id,
          answer_text = NULL, answered_at = EXCLUDED.answered_at
      `, [randomUUID(), attemptId, questionId, optionId, answeredAt]);
      return true;
    },
    async getAttempt(attemptId, examId, userId) {
      const { rows: [row] } = await database.query(`
        SELECT * FROM exam_attempts WHERE id = $1 AND exam_id = $2 AND user_id = $3
      `, [attemptId, examId, userId]);
      return row ? {
        id: row.id,
        userId: row.user_id,
        examId: row.exam_id,
        status: row.status,
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        submittedAt: row.submitted_at,
        violationCount: Number(row.violation_count ?? 0),
        lockedUntil: row.locked_until,
        disqualifiedAt: row.disqualified_at,
      } : null;
    },
    async findActiveAttempt(examId, userId) {
      const { rows: [row] } = await database.query(`
        SELECT * FROM exam_attempts
        WHERE exam_id = $1 AND user_id = $2 AND status = 'in_progress'
        ORDER BY started_at DESC LIMIT 1
      `, [examId, userId]);
      return row ? {
        id: row.id,
        userId: row.user_id,
        examId: row.exam_id,
        status: row.status,
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        submittedAt: row.submitted_at,
        violationCount: Number(row.violation_count ?? 0),
        lockedUntil: row.locked_until,
        disqualifiedAt: row.disqualified_at,
      } : null;
    },
    async recordExamActivity({ examId, attemptId, userId, eventType, occurredAt }) {
      return withTransaction(database, async (client) => {
        const { rows: [exam] } = await client.query(`
          SELECT e.school_id
          FROM exams e
          JOIN teacher_exam_settings tes ON tes.exam_id = e.id
          JOIN exam_classes ec ON ec.exam_id = e.id
          JOIN class_members cm ON cm.class_id = ec.class_id
          WHERE e.id = $1 AND cm.student_user_id = $2
            AND tes.workflow_status IN ('scheduled', 'active', 'completed')
          LIMIT 1
        `, [examId, userId]);
        if (!exam) return null;

        let attempt = null;
        if (attemptId) {
          const { rows: [row] } = await client.query(`
            SELECT id, status, violation_count, locked_until, disqualified_at
            FROM exam_attempts
            WHERE id = $1 AND exam_id = $2 AND user_id = $3
            FOR UPDATE
          `, [attemptId, examId, userId]);
          if (!row || row.status !== "in_progress") throw new Error("ATTEMPT_INVALID");
          attempt = row;
        }

        const recentCutoff = new Date(Date.parse(occurredAt) - 2500).toISOString();
        const { rows: [duplicate] } = await client.query(`
          SELECT violation_number FROM exam_activity_events
          WHERE exam_id = $1 AND user_id = $2 AND event_type = $3
            AND occurred_at >= $4
            AND attempt_id IS NOT DISTINCT FROM $5
          ORDER BY occurred_at DESC LIMIT 1
        `, [examId, userId, eventType, recentCutoff, attemptId ?? null]);
        if (duplicate) {
          return {
            violationCount: attempt?.violation_count ?? duplicate.violation_number,
            lockedUntil: attempt?.locked_until ?? null,
            disqualified: Boolean(attempt?.disqualified_at),
            duplicate: true,
          };
        }

        let violationCount = 1;
        let lockedUntil = null;
        let disqualified = false;
        if (attempt) {
          violationCount = Number(attempt.violation_count) + 1;
          lockedUntil = violationCount === 2
            ? new Date(Date.parse(occurredAt) + 30_000).toISOString()
            : attempt.locked_until;
          disqualified = violationCount >= 3;
          await client.query(`
            UPDATE exam_attempts
            SET violation_count = $1,
              locked_until = $2,
              disqualified_at = CASE WHEN $3 THEN $4 ELSE disqualified_at END
            WHERE id = $5
          `, [violationCount, lockedUntil, disqualified, occurredAt, attemptId]);
        } else {
          const { rows: [count] } = await client.query(`
            SELECT COUNT(*)::INTEGER AS count
            FROM exam_activity_events
            WHERE exam_id = $1 AND user_id = $2 AND attempt_id IS NULL
          `, [examId, userId]);
          violationCount = Number(count.count) + 1;
        }

        await client.query(`
          INSERT INTO exam_activity_events (
            id, exam_id, attempt_id, user_id, school_id, event_type,
            violation_number, occurred_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          randomUUID(), examId, attemptId ?? null, userId, exam.school_id,
          eventType, violationCount, occurredAt,
        ]);
        return { violationCount, lockedUntil, disqualified, duplicate: false };
      });
    },
    async hasResult(examId, userId) {
      const { rows: [row] } = await database.query(
        "SELECT 1 FROM exam_results WHERE exam_id = $1 AND user_id = $2",
        [examId, userId],
      );
      return Boolean(row);
    },
    async createAttempt({ id, userId, examId, startedAt, expiresAt }) {
      const { rows: [exam] } = await database.query(
        "SELECT school_id FROM exams WHERE id = $1",
        [examId],
      );
      await database.query(`
        INSERT INTO exam_attempts (id, user_id, exam_id, school_id, status, started_at, expires_at)
        VALUES ($1, $2, $3, $4, 'in_progress', $5, $6)
      `, [id, userId, examId, exam.school_id, startedAt, expiresAt]);
      return this.getAttempt(id, examId, userId);
    },
    async gradeAttempt({ attempt, resultId, submittedAt }) {
      const savedResultId = await withTransaction(database, async (client) => {
        const { rows: [lockedAttempt] } = await client.query(`
          SELECT status FROM exam_attempts WHERE id = $1 FOR UPDATE
        `, [attempt.id]);
        if (!lockedAttempt) throw new Error("ATTEMPT_NOT_FOUND");
        if (lockedAttempt.status === "submitted") {
          const { rows: [existing] } = await client.query(
            "SELECT id FROM exam_results WHERE attempt_id = $1 AND user_id = $2",
            [attempt.id, attempt.userId],
          );
          if (existing) return existing.id;
          throw new Error("ATTEMPT_RESULT_MISSING");
        }
        const { rows: answers } = await client.query(`
          SELECT q.id AS question_id, o.is_correct, a.selected_option_id
          FROM exam_questions q
          LEFT JOIN exam_answers a
            ON a.question_id = q.id AND a.attempt_id = $1
          LEFT JOIN exam_options o ON o.id = a.selected_option_id
          WHERE q.exam_id = $2
        `, [attempt.id, attempt.examId]);
        const correctCount = answers.filter((answer) => answer.is_correct === true).length;
        const unansweredCount = answers.filter((answer) => answer.selected_option_id === null).length;
        const wrongCount = answers.length - correctCount - unansweredCount;
        const score = answers.length ? Math.round((correctCount / answers.length) * 10000) / 100 : 0;
        const durationSeconds = Math.max(
          0,
          Math.min(
            Math.floor((Date.parse(submittedAt) - Date.parse(attempt.startedAt)) / 1000),
            Math.floor((Date.parse(attempt.expiresAt) - Date.parse(attempt.startedAt)) / 1000),
          ),
        );
        const { rows: [exam] } = await client.query(
          "SELECT school_id FROM exams WHERE id = $1",
          [attempt.examId],
        );
        await client.query(`
          UPDATE exam_attempts SET status = 'submitted', submitted_at = $1
          WHERE id = $2 AND status = 'in_progress'
        `, [submittedAt, attempt.id]);
        await client.query(`
          INSERT INTO exam_results (
            id, attempt_id, user_id, exam_id, school_id, score, correct_count,
            wrong_count, unanswered_count, duration_seconds, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          resultId, attempt.id, attempt.userId, attempt.examId, exam.school_id,
          score, correctCount, wrongCount, unansweredCount, durationSeconds, submittedAt,
        ]);
        return resultId;
      });
      return this.getResult(savedResultId, attempt.userId);
    },
    async getExistingResultForAttempt(attemptId, userId) {
      const { rows: [row] } = await database.query(
        "SELECT id FROM exam_results WHERE attempt_id = $1 AND user_id = $2",
        [attemptId, userId],
      );
      return row ? this.getResult(row.id, userId) : null;
    },
    async listResults(userId) {
      const { rows } = await database.query(`
        SELECT r.*, e.title AS exam_title, e.subject, e.code,
          tes.kkm,
          (SELECT status FROM remedial_requests rr WHERE rr.result_id = r.id) AS remedial_status
        FROM exam_results r
        JOIN exams e ON e.id = r.exam_id
        LEFT JOIN teacher_exam_settings tes ON tes.exam_id = e.id
        WHERE r.user_id = $1
        ORDER BY r.created_at DESC
      `, [userId]);
      return rows.map(mapResult);
    },
    async getResult(id, userId) {
      const { rows: [resultRow] } = await database.query(resultQuery, [id, userId]);
      const result = mapResult(resultRow);
      if (!result) return null;
      const { rows: questions } = await database.query(`
        SELECT q.id, q.position, q.prompt, q.type, a.selected_option_id,
          correct.id AS correct_option_id
        FROM exam_questions q
        LEFT JOIN exam_answers a ON a.question_id = q.id AND a.attempt_id = $1
        LEFT JOIN exam_options correct ON correct.question_id = q.id AND correct.is_correct = TRUE
        WHERE q.exam_id = $2
        ORDER BY q.position
      `, [result.attemptId, result.examId]);
      const { rows: [randomization] } = await database.query(`
        SELECT randomize_questions, randomize_options
        FROM teacher_exam_settings WHERE exam_id = $1
      `, [result.examId]);
      const stableSort = (items, seed, getId) => items.sort((left, right) => {
        const leftKey = createHash("sha256").update(`${seed}:${getId(left)}`).digest("hex");
        const rightKey = createHash("sha256").update(`${seed}:${getId(right)}`).digest("hex");
        return leftKey.localeCompare(rightKey);
      });
      if (randomization?.randomize_questions) {
        stableSort(questions, result.attemptId, (question) => question.id);
      }
      const { rows: options } = await database.query(`
        SELECT question_id, id, label, content, position
        FROM exam_options
        WHERE question_id = ANY($1::text[])
        ORDER BY position
      `, [questions.map((question) => question.id)]);
      const optionsByQuestion = new Map();
      for (const option of options) {
        const group = optionsByQuestion.get(option.question_id) ?? [];
        group.push({ id: option.id, label: option.label, content: option.content });
        optionsByQuestion.set(option.question_id, group);
      }
      return {
        ...result,
        questions: questions.map((question, index) => {
          const questionOptions = optionsByQuestion.get(question.id) ?? [];
          const orderedOptions = randomization?.randomize_options &&
            question.type !== "matching"
            ? stableSort(questionOptions, result.attemptId, (option) =>
              `${question.id}:${option.id}`)
            : questionOptions;
          const status = !question.selected_option_id
            ? "unanswered"
            : question.selected_option_id === question.correct_option_id
              ? "correct"
              : "wrong";
          return ({
          id: question.id,
          number: index + 1,
          prompt: question.prompt,
          selectedOptionId: question.selected_option_id,
          correctOptionId: question.correct_option_id,
          status,
          options: orderedOptions,
          });
        }),
      };
    },
    async requestRemedial(userId, resultId, now) {
      return withTransaction(database, async (client) => {
        const { rows: [result] } = await client.query(`
          SELECT r.id, r.exam_id, r.school_id, r.score, e.title, e.subject,
            tes.teacher_id, tes.kkm
          FROM exam_results r
          JOIN exams e ON e.id = r.exam_id
          JOIN teacher_exam_settings tes ON tes.exam_id = e.id
          WHERE r.id = $1 AND r.user_id = $2
          FOR UPDATE OF r
        `, [resultId, userId]);
        if (!result) return null;
        if (Number(result.score) >= Number(result.kkm)) {
          throw new Error("REMEDIAL_NOT_NEEDED");
        }
        const { rows: [existing] } = await client.query(`
          SELECT id, status FROM remedial_requests
          WHERE result_id = $1 FOR UPDATE
        `, [resultId]);
        if (existing && existing.status !== "rejected") {
          return { id: existing.id, status: existing.status };
        }
        if (existing) {
          const { rows: [updated] } = await client.query(`
            UPDATE remedial_requests
            SET status = 'pending', scheduled_exam_id = NULL,
                updated_at = $2, decided_at = NULL
            WHERE id = $1
            RETURNING id, status
          `, [existing.id, now]);
          return updated;
        }
        const { rows: [created] } = await client.query(`
          INSERT INTO remedial_requests (
            id, result_id, exam_id, student_id, teacher_id, school_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
          RETURNING id, status
        `, [
          randomUUID(), result.id, result.exam_id, userId, result.teacher_id,
          result.school_id, now,
        ]);
        return created;
      });
    },
  };
}
