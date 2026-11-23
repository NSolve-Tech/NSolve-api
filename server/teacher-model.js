import { randomInt, randomUUID } from "node:crypto";
import { withTransaction } from "./database.js";

function mapQuestion(row, options = []) {
  return {
    id: row.id,
    schoolId: row.school_id,
    schoolName: row.school_name,
    academicYear: row.academic_year,
    subject: row.subject,
    gradeLevel: row.grade_level,
    chapter: row.chapter,
    difficulty: row.difficulty,
    type: row.type,
    prompt: row.prompt,
    answerKey: row.answer_key,
    explanation: row.explanation,
    points: Number(row.points ?? 1),
    createdAt: row.created_at,
    options,
  };
}

function mapExam(row) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    code: row.code,
    description: row.description,
    status: row.workflow_status,
    durationMinutes: Number(row.duration_minutes),
    createdAt: row.created_at,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    publishedAt: row.published_at,
    academicYear: row.academic_year,
    examType: row.exam_type,
    semester: row.semester,
    gradeLevel: row.grade_level,
    mcQuestionCount: Number(row.mc_question_count),
    essayQuestionCount: Number(row.essay_question_count),
    kkm: Number(row.kkm ?? 75),
    randomizeQuestions: row.randomize_questions,
    randomizeOptions: row.randomize_options,
    autoGrade: row.auto_grade,
    visibility: row.visibility ?? "private",
    showScore: row.show_score !== false,
    questionCount: Number(row.question_count),
    participantCount: Number(row.participant_count),
    classes: row.classes ?? [],
    teacherName: row.teacher_name,
    schoolName: row.school_name,
  };
}

const examRows = `
  SELECT e.*, s.name AS school_name, p.full_name AS teacher_name,
    tes.academic_year, tes.semester, tes.grade_level,
    tes.mc_question_count, tes.essay_question_count,
    tes.kkm, tes.randomize_questions, tes.randomize_options, tes.auto_grade, tes.visibility,
    tes.show_score,
    tes.exam_type, tes.workflow_status,
    (SELECT COUNT(*)::INTEGER FROM exam_questions q WHERE q.exam_id = e.id) AS question_count,
    (SELECT COUNT(*)::INTEGER FROM exam_classes ec
      JOIN class_members cm ON cm.class_id = ec.class_id
      WHERE ec.exam_id = e.id) AS participant_count,
    (SELECT COALESCE(json_agg(json_build_object(
      'id', c.id, 'name', c.name, 'gradeLevel', c.grade_level, 'program', c.program
    ) ORDER BY c.name), '[]'::json)
      FROM exam_classes ec JOIN classes c ON c.id = ec.class_id
      WHERE ec.exam_id = e.id) AS classes
  FROM exams e
  JOIN teacher_exam_settings tes ON tes.exam_id = e.id
  JOIN teachers p ON p.id = tes.teacher_id
  JOIN schools s ON s.id = tes.school_id
`;

export function createTeacherModel(database) {
  async function getQuestion(id, teacherId) {
    const { rows: [row] } = await database.query(`
      SELECT q.*, s.name AS school_name
      FROM question_bank q JOIN schools s ON s.id = q.school_id
      WHERE q.id = $1 AND q.teacher_id = $2
    `, [id, teacherId]);
    if (!row) return null;
    const { rows: options } = await database.query(`
      SELECT id, label, content, is_correct AS "isCorrect", position
      FROM question_bank_options
      WHERE question_id = $1 ORDER BY position
    `, [id]);
    return mapQuestion(row, options);
  }

  async function getExam(id, teacherId) {
    const { rows: [row] } = await database.query(`
      ${examRows}
      WHERE tes.teacher_id = $1 AND e.id = $2
    `, [teacherId, id]);
    if (!row) return null;
    const { rows: classes } = await database.query(`
      SELECT c.id, c.name, c.grade_level AS "gradeLevel", c.program,
        (SELECT COUNT(*)::INTEGER FROM class_members cm WHERE cm.class_id = c.id) AS "studentCount"
      FROM exam_classes ec JOIN classes c ON c.id = ec.class_id
      WHERE ec.exam_id = $1 ORDER BY c.name
    `, [id]);
    const { rows: questions } = await database.query(`
      SELECT q.id, q.position, q.prompt, q.type, q.points,
        q.answer_key AS "answerKey",
        q.requires_manual_grading AS "requiresManualGrading",
        b.id AS bank_question_id
      FROM exam_questions q
      LEFT JOIN question_bank b ON b.id = q.bank_question_id
      WHERE q.exam_id = $1 ORDER BY q.position
    `, [id]);
    const questionDetails = await Promise.all(questions.map(async (question) => {
      const { rows: options } = await database.query(`
        SELECT id, label, content, position, is_correct AS "isCorrect"
        FROM exam_options WHERE question_id = $1 ORDER BY position
      `, [question.id]);
      return {
        id: question.id,
        position: question.position,
        prompt: question.prompt,
        type: question.type,
        points: Number(question.points),
        answerKey: question.answerKey,
        requiresManualGrading: question.requiresManualGrading,
        bankQuestionId: question.bank_question_id,
        options,
      };
    }));
    return { ...mapExam({ ...row, classes }), questions: questionDetails };
  }

  async function listClasses(profile) {
    const { rows } = await database.query(`
      SELECT c.id, c.name, c.grade_level AS "gradeLevel", c.program,
        (SELECT COUNT(*)::INTEGER FROM class_members cm WHERE cm.class_id = c.id) AS "studentCount"
      FROM teacher_classes tc
      JOIN classes c ON c.id = tc.class_id AND c.school_id = tc.school_id
      WHERE tc.teacher_id = $1 AND tc.school_id = $2
      ORDER BY c.name
    `, [profile.id, profile.schoolId]);
    return rows;
  }

  async function listAvailableClasses(profile) {
    return listClasses(profile);
  }

  async function listStudents(profile) {
    const { rows } = await database.query(`
      SELECT u.id, u.full_name AS "fullName", u.email,
        c.id AS "classId", c.name AS "className"
      FROM users u
      JOIN class_members cm ON cm.student_user_id = u.id
      JOIN classes c ON c.id = cm.class_id AND c.school_id = $2
      JOIN teacher_classes tc ON tc.class_id = c.id AND tc.teacher_id = $1
      WHERE u.role = 'student' AND u.school_id = $2
      ORDER BY c.name, u.full_name
    `, [profile.id, profile.schoolId]);
    return rows;
  }

  async function markCompletedExams(teacherId, now) {
    await database.query(`
      WITH completed AS (
        UPDATE teacher_exam_settings
        SET workflow_status = 'completed'
        WHERE teacher_id = $1 AND workflow_status IN ('scheduled', 'active')
          AND exam_id IN (SELECT id FROM exams WHERE closes_at <= $2)
        RETURNING exam_id
      )
      UPDATE exams SET status = 'closed'
      WHERE id IN (SELECT exam_id FROM completed)
    `, [teacherId, now]);
  }

  async function ensureSubjectId(client, profile, name = profile.subject) {
    if (name === profile.subject && profile.subjectId) return profile.subjectId;
    const { rows: [subject] } = await client.query(`
      INSERT INTO subjects (id, school_id, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (school_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [randomUUID(), profile.schoolId, name]);
    return subject.id;
  }

  async function listRemedialRequests(profile) {
    const { rows } = await database.query(`
      SELECT rr.id, rr.exam_id AS "examId", rr.status, rr.created_at AS "createdAt",
        rr.scheduled_exam_id AS "scheduledExamId",
        e.title AS "examTitle", e.subject, r.score, tes.kkm,
        u.full_name AS "studentName", u.id AS "studentId",
        target_class.id AS "classId",
        COALESCE(target_class.name, '—') AS "className",
        scheduled.title AS "scheduledExamTitle"
      FROM remedial_requests rr
      JOIN exams e ON e.id = rr.exam_id AND e.school_id = rr.school_id
      JOIN exam_results r ON r.id = rr.result_id
      JOIN users u ON u.id = rr.student_id AND u.school_id = rr.school_id
      JOIN teacher_exam_settings tes ON tes.exam_id = e.id
      LEFT JOIN LATERAL (
        SELECT c.id, c.name
        FROM exam_classes ec
        JOIN classes c ON c.id = ec.class_id AND c.school_id = ec.school_id
        JOIN class_members cm ON cm.class_id = ec.class_id
        WHERE ec.exam_id = rr.exam_id AND cm.student_user_id = rr.student_id
        ORDER BY c.name LIMIT 1
      ) target_class ON TRUE
      LEFT JOIN exams scheduled ON scheduled.id = rr.scheduled_exam_id
      WHERE rr.teacher_id = $1 AND rr.school_id = $2
      ORDER BY CASE rr.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
        rr.created_at DESC
    `, [profile.id, profile.schoolId]);
    return rows.map((row) => ({
      ...row,
      score: Number(row.score),
      kkm: Number(row.kkm),
    }));
  }

  async function setRemedialRequestStatus(profile, requestId, status) {
    return withTransaction(database, async (client) => {
      const { rows: [request] } = await client.query(`
        SELECT id, status FROM remedial_requests
        WHERE id = $1 AND teacher_id = $2 AND school_id = $3
        FOR UPDATE
      `, [requestId, profile.id, profile.schoolId]);
      if (!request) return null;
      if (request.status !== "pending") throw new Error("REMEDIAL_ALREADY_DECIDED");
      await client.query(`
        UPDATE remedial_requests
        SET status = $1, updated_at = NOW(), decided_at = NOW()
        WHERE id = $2
      `, [status, requestId]);
      return { id: requestId, status };
    });
  }

  async function scheduleRemedialRequest(profile, requestId, examId) {
    return withTransaction(database, async (client) => {
      const { rows: [request] } = await client.query(`
        SELECT id, status FROM remedial_requests
        WHERE id = $1 AND teacher_id = $2 AND school_id = $3
        FOR UPDATE
      `, [requestId, profile.id, profile.schoolId]);
      if (!request) return null;
      if (request.status !== "approved") throw new Error("REMEDIAL_NOT_APPROVED");
      const { rows: [exam] } = await client.query(`
        SELECT e.id
        FROM exams e
        JOIN teacher_exam_settings tes ON tes.exam_id = e.id
        WHERE e.id = $1 AND e.school_id = $2 AND tes.teacher_id = $3
          AND tes.workflow_status IN ('scheduled', 'active')
          AND e.published_at IS NOT NULL
          AND e.id <> (
            SELECT exam_id FROM remedial_requests WHERE id = $4
          )
          AND e.subject_id = (
            SELECT original.subject_id FROM remedial_requests rr
            JOIN exams original ON original.id = rr.exam_id
            WHERE rr.id = $4
          )
          AND EXISTS (
            SELECT 1 FROM remedial_requests rr
            JOIN exam_classes ec ON ec.exam_id = e.id AND ec.school_id = rr.school_id
            JOIN class_members cm ON cm.class_id = ec.class_id
            WHERE rr.id = $4 AND cm.student_user_id = rr.student_id
          )
      `, [examId, profile.schoolId, profile.id, requestId]);
      if (!exam) throw new Error("REMEDIAL_EXAM_INVALID");
      await client.query(`
        UPDATE remedial_requests
        SET status = 'scheduled', scheduled_exam_id = $1, updated_at = NOW()
        WHERE id = $2
      `, [examId, requestId]);
      return { id: requestId, status: "scheduled", scheduledExamId: examId };
    });
  }

  async function insertQuestion(client, profile, input, now) {
    const id = randomUUID();
    const subjectId = await ensureSubjectId(client, profile, input.subject);
    await client.query(`
      INSERT INTO question_bank (
        id, teacher_id, school_id, subject_id, academic_year, subject, grade_level,
        chapter, difficulty, type, prompt, answer_key, explanation, points, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      id, profile.id, profile.schoolId, subjectId, input.academicYear, input.subject,
      input.gradeLevel, input.chapter, input.difficulty, input.type,
      input.prompt, input.answerKey, input.explanation, input.points, now,
    ]);
    for (const [index, option] of input.options.entries()) {
      await client.query(`
        INSERT INTO question_bank_options
          (id, question_id, position, label, content, is_correct)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [randomUUID(), id, index + 1, option.label, option.content, option.isCorrect]);
    }
    return id;
  }

  return {
    async findProfileByUserId(userId) {
      const { rows: [row] } = await database.query(`
        SELECT p.*, s.name AS school_name
        FROM teachers p
        JOIN schools s ON s.id = p.school_id
        WHERE p.user_id = $1
      `, [userId]);
      return row ? {
        id: row.id,
        userId: row.user_id,
        fullName: row.full_name,
        schoolId: row.school_id,
        schoolName: row.school_name,
        subjectId: row.subject_id,
        subject: row.subject,
        positionTitle: row.position_title,
        academicYear: row.academic_year,
      } : null;
    },
    async listSubjects(profile) {
      const { rows } = await database.query(`
        SELECT id, name
        FROM subjects
        WHERE school_id = $1
        ORDER BY name
      `, [profile.schoolId]);
      return rows;
    },
    async updateProfile(profile, input) {
      const subjectId = await withTransaction(database, async (client) => {
        const nextSubjectId = await ensureSubjectId(client, {
          ...profile,
          subject: input.subject,
        });
        await client.query(`
          UPDATE teachers
          SET full_name = $1, position_title = $2, subject = $3,
              subject_id = $4, academic_year = $5
          WHERE id = $6 AND school_id = $7
        `, [
          input.fullName,
          input.positionTitle,
          input.subject,
          nextSubjectId,
          input.academicYear,
          profile.id,
          profile.schoolId,
        ]);
        await client.query(`
          UPDATE users
          SET full_name = $1
          WHERE id = $2 AND school_id = $3
        `, [input.fullName, profile.userId, profile.schoolId]);
        return nextSubjectId;
      });
      return {
        ...profile,
        fullName: input.fullName,
        subjectId,
        subject: input.subject,
        positionTitle: input.positionTitle,
        academicYear: input.academicYear,
      };
    },
    async getDashboard(profile) {
      await markCompletedExams(profile.id, new Date());
      const { rows: [stats] } = await database.query(`
        SELECT
          (SELECT COUNT(*)::INTEGER FROM teacher_exam_settings WHERE teacher_id = $1) AS total_exams,
          (SELECT COUNT(*)::INTEGER FROM teacher_exam_settings WHERE teacher_id = $1 AND workflow_status = 'active') AS active_exams,
          (SELECT COUNT(*)::INTEGER FROM teacher_exam_settings WHERE teacher_id = $1 AND workflow_status = 'completed') AS completed_exams,
          (SELECT COUNT(*)::INTEGER FROM question_bank WHERE teacher_id = $1) AS total_questions,
          (SELECT COUNT(*)::INTEGER FROM teacher_classes tc
            WHERE tc.teacher_id = $1 AND tc.school_id = $2) AS total_classes,
          (SELECT COUNT(DISTINCT (ec.exam_id, cm.student_user_id))::INTEGER
            FROM teacher_exam_settings settings
            JOIN exam_classes ec ON ec.exam_id = settings.exam_id
            JOIN class_members cm ON cm.class_id = ec.class_id
            WHERE settings.teacher_id = $1 AND settings.school_id = $2) AS total_students
      `, [profile.id, profile.schoolId]);
      const { rows } = await database.query(`
        ${examRows}
        WHERE tes.teacher_id = $1
        ORDER BY e.created_at DESC
      `, [profile.id]);
      const exams = rows.map(mapExam);
      return {
        teacher: profile,
        stats: {
          activeExams: stats.active_exams,
          completedExams: stats.completed_exams,
          totalQuestions: stats.total_questions,
          totalStudents: stats.total_students,
          totalClasses: stats.total_classes,
          totalExams: stats.total_exams,
        },
        upcomingExams: exams
          .filter((exam) => ["scheduled", "active"].includes(exam.status))
          .sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt))
          .slice(0, 3),
        recentExams: exams.slice(0, 5),
        remedialRequests: await listRemedialRequests(profile),
        classes: await listClasses(profile),
      };
    },
    async listRemedialRequests(profile) {
      return listRemedialRequests(profile);
    },
    async setRemedialRequestStatus(profile, requestId, status) {
      return setRemedialRequestStatus(profile, requestId, status);
    },
    async scheduleRemedialRequest(profile, requestId, examId) {
      return scheduleRemedialRequest(profile, requestId, examId);
    },
    listClasses,
    listAvailableClasses,
    async createClass(profile, input) {
      const id = randomUUID();
      await database.query(`
        INSERT INTO classes (id, school_id, name, grade_level, program)
        VALUES ($1, $2, $3, $4, '')
      `, [id, profile.schoolId, input.name, input.gradeLevel]);
      return listClasses(profile).then((classes) => classes.find((item) => item.id === id) ?? null);
    },
    async updateClass(id, profile, input) {
      const { rows } = await database.query(`
        UPDATE classes
        SET name = $1, grade_level = $2, program = ''
        WHERE id = $3 AND school_id = $4
        RETURNING id
      `, [input.name, input.gradeLevel, id, profile.schoolId]);
      if (!rows.length) return null;
      const classes = await listClasses(profile);
      return classes.find((item) => item.id === id) ?? null;
    },
    async deleteClass(id, profile) {
      const { rows } = await database.query(`
        DELETE FROM classes
        WHERE id = $1 AND school_id = $2
        RETURNING id
      `, [id, profile.schoolId]);
      return rows.length > 0;
    },
    async listQuestions(profile, filters = {}) {
      const where = ["q.teacher_id = $1", "q.school_id = $2"];
      const values = [profile.id, profile.schoolId];
      for (const [field, column] of [
        ["subject", "q.subject"],
        ["gradeLevel", "q.grade_level"],
        ["chapter", "q.chapter"],
        ["difficulty", "q.difficulty"],
        ["type", "q.type"],
      ]) {
        if (filters[field]) {
          values.push(filters[field]);
          where.push(`${column} = $${values.length}`);
        }
      }
      if (filters.search) {
        values.push(`%${filters.search}%`);
        const searchIndex = values.length;
        values.push(`%${filters.search}%`);
        where.push(`(q.prompt ILIKE $${searchIndex} OR q.chapter ILIKE $${searchIndex + 1})`);
      }
      const { rows: [countRow] } = await database.query(`
        SELECT COUNT(*)::INTEGER AS total
        FROM question_bank q
        WHERE ${where.join(" AND ")}
      `, values);
      const total = Number(countRow.total);
      const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
      const pageSize = Math.min(500, Math.max(1, Number.parseInt(filters.pageSize, 10) || 10));
      const questionValues = [...values, pageSize, (page - 1) * pageSize];
      const { rows } = await database.query(`
        SELECT q.*, s.name AS school_name
        FROM question_bank q JOIN schools s ON s.id = q.school_id
        WHERE ${where.join(" AND ")}
        ORDER BY q.created_at DESC, q.id
        LIMIT $${questionValues.length - 1} OFFSET $${questionValues.length}
      `, questionValues);
      const questions = await Promise.all(rows.map(async (row) => {
        const { rows: options } = await database.query(`
          SELECT id, label, content, is_correct AS "isCorrect", position
          FROM question_bank_options
          WHERE question_id = $1 ORDER BY position
        `, [row.id]);
        return mapQuestion(row, options);
      }));
      return {
        questions,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      };
    },
    getQuestion,
    async createQuestion(profile, input, now) {
      const [id] = await withTransaction(database, async (client) => [
        await insertQuestion(client, profile, input, now),
      ]);
      return getQuestion(id, profile.id);
    },
    async createQuestions(profile, inputs, now) {
      const ids = await withTransaction(database, async (client) => {
        const createdIds = [];
        for (const input of inputs) {
          createdIds.push(await insertQuestion(client, profile, input, now));
        }
        return createdIds;
      });
      return Promise.all(ids.map((id) => getQuestion(id, profile.id)));
    },
    async updateQuestion(id, profile, input) {
      const updated = await withTransaction(database, async (client) => {
        const subjectId = await ensureSubjectId(client, profile, input.subject);
        const { rows } = await client.query(`
          UPDATE question_bank SET
            academic_year = $1, subject_id = $2, subject = $3, grade_level = $4,
            chapter = $5, difficulty = $6, type = $7, prompt = $8,
            answer_key = $9, explanation = $10, points = $11
          WHERE id = $12 AND teacher_id = $13 AND school_id = $14
          RETURNING id
        `, [
          input.academicYear, subjectId, input.subject, input.gradeLevel, input.chapter,
          input.difficulty, input.type, input.prompt, input.answerKey, input.explanation, input.points,
          id, profile.id, profile.schoolId,
        ]);
        if (!rows.length) return false;
        await client.query("DELETE FROM question_bank_options WHERE question_id = $1", [id]);
        for (const [index, option] of input.options.entries()) {
          await client.query(`
            INSERT INTO question_bank_options
              (id, question_id, position, label, content, is_correct)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [randomUUID(), id, index + 1, option.label, option.content, option.isCorrect]);
        }
        return true;
      });
      return updated ? getQuestion(id, profile.id) : null;
    },
    async deleteQuestion(id, profile) {
      return withTransaction(database, async (client) => {
        const { rows: [question] } = await client.query(`
          SELECT id FROM question_bank
          WHERE id = $1 AND teacher_id = $2 AND school_id = $3
          FOR UPDATE
        `, [id, profile.id, profile.schoolId]);
        if (!question) return false;
        await client.query(
          "UPDATE exam_questions SET bank_question_id = NULL WHERE bank_question_id = $1",
          [id],
        );
        await client.query(
          "DELETE FROM question_bank_options WHERE question_id = $1",
          [id],
        );
        await client.query(
          "DELETE FROM question_bank WHERE id = $1 AND teacher_id = $2 AND school_id = $3",
          [id, profile.id, profile.schoolId],
        );
        return true;
      });
    },
    async listExams(profile) {
      await markCompletedExams(profile.id, new Date());
      const { rows } = await database.query(`
        ${examRows}
        WHERE tes.teacher_id = $1 ORDER BY e.created_at DESC
      `, [profile.id]);
      return rows.map(mapExam);
    },
    async getExam(id, profile) {
      await markCompletedExams(profile.id, new Date());
      return getExam(id, profile.id);
    },
    async updateExam(id, profile, input) {
      const { rows: [settings] } = await database.query(`
        SELECT exam_id FROM teacher_exam_settings
        WHERE exam_id = $1 AND teacher_id = $2
      `, [id, profile.id]);
      if (!settings) return null;

      const { rows: [attempt] } = await database.query(
        "SELECT 1 FROM exam_attempts WHERE exam_id = $1 LIMIT 1",
        [id],
      );
      if (attempt) throw new Error("EXAM_ALREADY_ATTEMPTED");
      if (!input.classIds.length) throw new Error("CLASS_REQUIRED");
      const classIds = [...new Set(input.classIds)];
      const { rows: classes } = await database.query(`
        SELECT c.id FROM classes c
        JOIN teacher_classes tc
          ON tc.class_id = c.id AND tc.school_id = c.school_id
        WHERE c.school_id = $1 AND c.id = ANY($2::text[])
          AND tc.teacher_id = $3
      `, [profile.schoolId, classIds, profile.id]);
      if (classes.length !== classIds.length) throw new Error("CLASS_INVALID");

      await withTransaction(database, async (client) => {
        if (input.code) {
          const { rows: duplicateCodes } = await client.query(
            "SELECT 1 FROM exams WHERE code = $1 AND id <> $2",
            [input.code, id],
          );
          if (duplicateCodes.length) throw new Error("EXAM_TOKEN_TAKEN");
        }
        const subjectId = await ensureSubjectId(client, profile, input.subject);
        await client.query(`
          UPDATE exams
          SET subject_id = $1, subject = $2, title = $3, description = $4,
              duration_minutes = $5, opens_at = $6, closes_at = $7,
              code = COALESCE($8, code),
              status = COALESCE($9, status)
          WHERE id = $10 AND school_id = $11
        `, [
          subjectId, input.subject, input.title, input.description, input.durationMinutes,
          input.opensAt, input.closesAt, input.code ?? null, input.status ?? null,
          id, profile.schoolId,
        ]);
        await client.query(`
          UPDATE teacher_exam_settings
          SET academic_year = $1, semester = $2, grade_level = $3,
              exam_type = $4, visibility = $5, mc_question_count = $6,
              essay_question_count = $7, kkm = $8, show_score = $9,
              randomize_questions = $10, randomize_options = $11, auto_grade = $12,
              workflow_status = COALESCE($13, workflow_status)
          WHERE exam_id = $14 AND teacher_id = $15
        `, [
          input.academicYear, input.semester, input.gradeLevel,
          input.examType, input.visibility, input.mcQuestionCount,
          input.essayQuestionCount, input.kkm, input.showScore,
          input.randomizeQuestions, input.randomizeOptions, input.autoGrade,
          input.status ?? null, id, profile.id,
        ]);
        await client.query("DELETE FROM exam_questions WHERE exam_id = $1", [id]);
        for (const [index, question] of input.questions.entries()) {
          const questionId = randomUUID();
          await client.query(`
            INSERT INTO exam_questions (
              id, exam_id, position, prompt, type, points, answer_key, requires_manual_grading
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [
            questionId, id, index + 1, question.prompt, question.type,
            question.points, question.answerKey,
            ["essay", "short_answer", "matching"].includes(question.type),
          ]);
          for (const [optionIndex, option] of question.options.entries()) {
            await client.query(`
              INSERT INTO exam_options (id, question_id, position, label, content, is_correct)
              VALUES ($1, $2, $3, $4, $5, $6)
            `, [
              randomUUID(), questionId, optionIndex + 1,
              option.label, option.content, option.isCorrect,
            ]);
          }
        }
        await client.query("DELETE FROM exam_classes WHERE exam_id = $1", [id]);
        for (const classId of classIds) {
          await client.query(`
            INSERT INTO exam_classes (exam_id, class_id, school_id) VALUES ($1, $2, $3)
          `, [id, classId, profile.schoolId]);
        }
      });
      return getExam(id, profile.id);
    },
    async updateExamToken(examId, profile, code) {
      const updated = await withTransaction(database, async (client) => {
        const { rows: [exam] } = await client.query(`
          SELECT e.id, e.published_at
          FROM exams e
          JOIN teacher_exam_settings tes ON tes.exam_id = e.id
          WHERE e.id = $1 AND e.school_id = $2 AND tes.teacher_id = $3
          FOR UPDATE OF e
        `, [examId, profile.schoolId, profile.id]);
        if (!exam) return false;
        if (!exam.published_at) throw new Error("EXAM_NOT_PUBLISHED");
        const { rows: duplicateCodes } = await client.query(
          "SELECT 1 FROM exams WHERE code = $1 AND id <> $2",
          [code, examId],
        );
        if (duplicateCodes.length) throw new Error("EXAM_TOKEN_TAKEN");
        await client.query(
          "UPDATE exams SET code = $1 WHERE id = $2 AND school_id = $3",
          [code, examId, profile.schoolId],
        );
        return true;
      });
      return updated ? getExam(examId, profile.id) : null;
    },
    async deleteExam(id, profile) {
      return withTransaction(database, async (client) => {
        const { rows: [exam] } = await client.query(`
          SELECT e.id FROM exams e
          JOIN teacher_exam_settings tes ON tes.exam_id = e.id
          WHERE e.id = $1 AND e.school_id = $2 AND tes.teacher_id = $3
          FOR UPDATE OF e
        `, [id, profile.schoolId, profile.id]);
        if (!exam) return false;
        const { rows: bankQuestions } = await client.query(`
          SELECT DISTINCT qb.id
          FROM exam_questions eq
          JOIN question_bank qb ON qb.id = eq.bank_question_id
          WHERE eq.exam_id = $1 AND qb.teacher_id = $2 AND qb.school_id = $3
        `, [id, profile.id, profile.schoolId]);
        const bankQuestionIds = bankQuestions.map((question) => question.id);
        const { rows: importedQuestions } = await client.query(`
          SELECT DISTINCT q.id
          FROM exam_questions eq
          JOIN questions q ON q.id = eq.imported_question_id
          WHERE eq.exam_id = $1 AND q.teacher_id = $2 AND q.school_id = $3
        `, [id, profile.id, profile.schoolId]);
        const importedQuestionIds = importedQuestions.map((question) => question.id);
        await client.query(`
          DELETE FROM remedial_requests
          WHERE school_id = $1 AND (exam_id = $2 OR scheduled_exam_id = $2)
        `, [profile.schoolId, id]);
        await client.query(
          "DELETE FROM exam_results WHERE school_id = $1 AND exam_id = $2",
          [profile.schoolId, id],
        );
        await client.query(
          "DELETE FROM exam_attempts WHERE school_id = $1 AND exam_id = $2",
          [profile.schoolId, id],
        );
        await client.query(
          "DELETE FROM exams WHERE id = $1 AND school_id = $2",
          [id, profile.schoolId],
        );
        if (bankQuestionIds.length) {
          await client.query(
            "UPDATE exam_questions SET bank_question_id = NULL WHERE bank_question_id = ANY($1::text[])",
            [bankQuestionIds],
          );
          await client.query(
            "DELETE FROM question_bank_options WHERE question_id = ANY($1::text[])",
            [bankQuestionIds],
          );
          await client.query(
            "DELETE FROM question_bank WHERE id = ANY($1::text[]) AND teacher_id = $2 AND school_id = $3",
            [bankQuestionIds, profile.id, profile.schoolId],
          );
        }
        if (importedQuestionIds.length) {
          await client.query(
            "UPDATE exam_questions SET imported_question_id = NULL WHERE imported_question_id = ANY($1::text[])",
            [importedQuestionIds],
          );
          await client.query(
            "DELETE FROM questions WHERE id = ANY($1::text[]) AND teacher_id = $2 AND school_id = $3",
            [importedQuestionIds, profile.id, profile.schoolId],
          );
        }
        return true;
      });
    },
    async createExam(profile, input, now) {
      const examId = randomUUID();
      const code = `DRAFT-${examId}`;
      const opensAt = input.opensAt ?? new Date(Date.parse(now) + 24 * 60 * 60_000);
      const closesAt = input.closesAt ?? new Date(
        Date.parse(opensAt) + input.durationMinutes * 60_000,
      );
      await withTransaction(database, async (client) => {
        const subjectId = await ensureSubjectId(client, profile, input.subject);
        const questionIds = [...new Set(input.questionIds)];
        const { rows: questionRows } = questionIds.length
          ? await client.query(`
            SELECT q.*, s.name AS school_name
            FROM question_bank q JOIN schools s ON s.id = q.school_id
            WHERE q.teacher_id = $1 AND q.school_id = $2 AND q.id = ANY($3::text[])
            ORDER BY q.created_at, q.id
          `, [profile.id, profile.schoolId, questionIds])
          : { rows: [] };
        if (questionRows.length !== questionIds.length) throw new Error("SOAL_BANK_INVALID");

        const classIds = [...new Set(input.classIds)];
        const { rows: classes } = classIds.length
          ? await client.query(`
            SELECT c.id FROM classes c
            JOIN teacher_classes tc
              ON tc.class_id = c.id AND tc.school_id = c.school_id
            WHERE c.school_id = $1 AND c.id = ANY($2::text[])
              AND tc.teacher_id = $3
          `, [profile.schoolId, classIds, profile.id])
          : { rows: [] };
        if (classes.length !== classIds.length) throw new Error("CLASS_INVALID");

        await client.query(`
          INSERT INTO exams (
            id, school_id, subject_id, title, subject, teacher_name, code, description, status,
            duration_minutes, opens_at, closes_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'closed', $9, $10, $11, $12)
        `, [
          examId, profile.schoolId, subjectId, input.title, input.subject, profile.fullName, code,
          input.description, input.durationMinutes, opensAt, closesAt, now,
        ]);
        await client.query(`
          INSERT INTO teacher_exam_settings (
            exam_id, teacher_id, school_id, academic_year, semester, grade_level,
            mc_question_count, essay_question_count, randomize_questions,
            randomize_options, auto_grade, workflow_status, exam_type, visibility, kkm, show_score
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, $13, $14, $15)
        `, [
          examId, profile.id, profile.schoolId, input.academicYear, input.semester,
          input.gradeLevel, input.mcQuestionCount, input.essayQuestionCount,
          input.randomizeQuestions, input.randomizeOptions, input.autoGrade, input.examType,
          input.visibility, input.kkm, input.showScore,
        ]);
        for (const [index, question] of questionRows.entries()) {
          const examQuestionId = randomUUID();
          await client.query(`
            INSERT INTO exam_questions (
              id, exam_id, position, prompt, type, bank_question_id, points,
              answer_key, requires_manual_grading
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [
            examQuestionId, examId, index + 1, question.prompt,
            question.type, question.id, question.points, question.answer_key,
            ["essay", "short_answer"].includes(question.type),
          ]);
          const { rows: options } = await client.query(`
            SELECT position, label, content, is_correct
            FROM question_bank_options WHERE question_id = $1 ORDER BY position
          `, [question.id]);
          for (const option of options) {
            await client.query(`
              INSERT INTO exam_options (id, question_id, position, label, content, is_correct)
              VALUES ($1, $2, $3, $4, $5, $6)
            `, [randomUUID(), examQuestionId, option.position, option.label, option.content, option.is_correct]);
          }
        }
        for (const classId of classIds) {
          await client.query(`
            INSERT INTO exam_classes (exam_id, class_id, school_id) VALUES ($1, $2, $3)
          `, [examId, classId, profile.schoolId]);
        }
      });
      return getExam(examId, profile.id);
    },
    async updateExamClasses(examId, profile, classIds) {
      const { rows: [exam] } = await database.query(`
        SELECT workflow_status FROM teacher_exam_settings
        WHERE exam_id = $1 AND teacher_id = $2
      `, [examId, profile.id]);
      if (!exam) return null;
      const uniqueClassIds = [...new Set(classIds)];
      const { rows: classes } = uniqueClassIds.length
        ? await database.query(`
          SELECT c.id FROM classes c
          JOIN teacher_classes tc
            ON tc.class_id = c.id AND tc.school_id = c.school_id
          WHERE c.school_id = $1 AND c.id = ANY($2::text[])
            AND tc.teacher_id = $3
        `, [profile.schoolId, uniqueClassIds, profile.id])
        : { rows: [] };
      if (classes.length !== uniqueClassIds.length) throw new Error("CLASS_INVALID");
      await withTransaction(database, async (client) => {
        await client.query("DELETE FROM exam_classes WHERE exam_id = $1", [examId]);
        for (const classId of uniqueClassIds) {
          await client.query(`
            INSERT INTO exam_classes (exam_id, class_id, school_id) VALUES ($1, $2, $3)
          `, [examId, classId, profile.schoolId]);
        }
      });
      return getExam(examId, profile.id);
    },
    async publishExam(examId, profile, input, now) {
      const exam = await getExam(examId, profile.id);
      if (!exam) return null;
      if (exam.questions.length === 0) throw new Error("QUESTION_COUNTS_MISMATCH");
      const visibility = input.visibility ?? exam.visibility ?? "private";
      if (exam.classes.length === 0) throw new Error("CLASS_REQUIRED");
      const classIds = exam.classes.map((schoolClass) => schoolClass.id);
      const { rows: assignedClasses } = await database.query(`
        SELECT class_id FROM teacher_classes
        WHERE teacher_id = $1 AND school_id = $2 AND class_id = ANY($3::text[])
      `, [profile.id, profile.schoolId, classIds]);
      if (assignedClasses.length !== classIds.length) throw new Error("CLASS_INVALID");
      if (!["scheduled", "active"].includes(input.status)) throw new Error("STATUS_INVALID");
      if (Date.parse(input.closesAt) <= Date.parse(input.opensAt)) {
        throw new Error("DATE_RANGE_INVALID");
      }
      const prefixes = {
        Kimia: "KIM",
        Fisika: "FIS",
        Matematika: "MAT",
        Biologi: "BIO",
        "Bahasa Indonesia": "BAH",
        "Bahasa Inggris": "ING",
        PPKN: "PPK",
        Ekonomi: "EKO",
        Sejarah: "SEJ",
        Informatika: "INF",
      };
      const subjectPrefix = prefixes[exam.subject] ??
        exam.subject.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "X");
      let token = input.code ?? (exam.code.startsWith("DRAFT-") ? "" : exam.code);
      if (input.code) {
        const { rows: duplicateCodes } = await database.query(
          "SELECT 1 FROM exams WHERE code = $1 AND id <> $2",
          [input.code, examId],
        );
        if (duplicateCodes.length) throw new Error("EXAM_TOKEN_TAKEN");
      } else if (!token) {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const candidate = `${subjectPrefix}${randomInt(10, 100)}${["#", "@", "!"][randomInt(0, 3)]}`;
          const { rows } = await database.query("SELECT 1 FROM exams WHERE code = $1", [candidate]);
          if (rows.length === 0) {
            token = candidate;
            break;
          }
        }
      }
      if (!token) throw new Error("EXAM_TOKEN_UNAVAILABLE");
      await withTransaction(database, async (client) => {
        await client.query(`
          UPDATE teacher_exam_settings
          SET workflow_status = $1, visibility = $2
          WHERE exam_id = $3 AND teacher_id = $4
        `, [input.status, input.visibility ?? "private", examId, profile.id]);
        await client.query(`
          UPDATE exams
          SET status = $1, opens_at = $2, closes_at = $3, code = $4, published_at = $5
          WHERE id = $6 AND school_id = $7
        `, [
          input.status === "active" ? "active" : "scheduled",
          input.opensAt, input.closesAt, token, now, examId, profile.schoolId,
        ]);
      });
      return getExam(examId, profile.id);
    },
    listStudents,
    async assignStudents(profile, classId, userIds, now) {
      const { rows: [classRow] } = await database.query(
        "SELECT id FROM classes WHERE id = $1 AND school_id = $2",
        [classId, profile.schoolId],
      );
      if (!classRow) return null;
      const uniqueUserIds = [...new Set(userIds)];
      const { rows: users } = uniqueUserIds.length
        ? await database.query(`
          SELECT id FROM users
          WHERE role = 'student' AND (school_id IS NULL OR school_id = $1)
            AND id = ANY($2::text[])
        `, [profile.schoolId, uniqueUserIds])
        : { rows: [] };
      if (users.length !== uniqueUserIds.length) throw new Error("STUDENT_INVALID");
      await withTransaction(database, async (client) => {
        for (const id of uniqueUserIds) {
          await client.query("UPDATE users SET school_id = $1 WHERE id = $2", [profile.schoolId, id]);
          await client.query(`
            INSERT INTO students (user_id, school_id, created_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE SET school_id = EXCLUDED.school_id
          `, [id, profile.schoolId, now]);
          await client.query(`
            INSERT INTO class_members (class_id, student_user_id, school_id, assigned_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (student_user_id) DO UPDATE SET
              class_id = EXCLUDED.class_id, school_id = EXCLUDED.school_id,
              assigned_at = EXCLUDED.assigned_at
          `, [classId, id, profile.schoolId, now]);
        }
      });
      return listStudents(profile);
    },
    async getAnalytics(examId, profile) {
      const exam = await getExam(examId, profile.id);
      if (!exam) return null;
      const { rows: [summary] } = await database.query(`
        SELECT
          COUNT(r.id)::INTEGER AS submissions,
          COALESCE(AVG(r.score), 0)::DOUBLE PRECISION AS average,
          COALESCE(MAX(r.score), 0)::DOUBLE PRECISION AS highest,
          COALESCE(MIN(r.score), 0)::DOUBLE PRECISION AS lowest,
          COUNT(r.id) FILTER (
            WHERE r.score >= (SELECT kkm FROM teacher_exam_settings WHERE exam_id = $1)
          )::INTEGER AS passed
        FROM exam_results r WHERE r.exam_id = $1
      `, [examId]);
      const { rows } = await database.query(`
        SELECT q.id, q.position, q.prompt, q.type,
          COUNT(DISTINCT r.id)::INTEGER AS response_count,
          COUNT(*) FILTER (WHERE o.is_correct)::INTEGER AS correct_count
        FROM exam_questions q
        LEFT JOIN exam_attempts a ON a.exam_id = q.exam_id AND a.status = 'submitted'
        LEFT JOIN exam_results r ON r.attempt_id = a.id
        LEFT JOIN exam_answers ans ON ans.attempt_id = a.id AND ans.question_id = q.id
        LEFT JOIN exam_options o ON o.id = ans.selected_option_id
        WHERE q.exam_id = $1
        GROUP BY q.id ORDER BY q.position
      `, [examId]);
      const questions = rows.map((question) => ({
        id: question.id,
        number: question.position,
        prompt: question.prompt,
        type: question.type,
        responseCount: Number(question.response_count),
        correctCount: Number(question.correct_count ?? 0),
        correctRate: question.response_count
          ? Math.round(Number(question.correct_count ?? 0) / Number(question.response_count) * 100)
          : 0,
      }));
      const completionPercent = summary.submissions && exam.participantCount
        ? Math.round(summary.submissions / exam.participantCount * 100)
        : 0;
      const { rows: participants } = await database.query(`
        SELECT u.id AS "studentId", u.full_name AS "fullName", c.name AS "className",
          r.score, r.correct_count AS "correctCount", r.wrong_count AS "wrongCount",
          r.unanswered_count AS "unansweredCount", r.id AS "resultId",
          (SELECT kkm FROM teacher_exam_settings WHERE exam_id = ec.exam_id) AS kkm
        FROM exam_classes ec
        JOIN classes c ON c.id = ec.class_id
        JOIN class_members cm ON cm.class_id = c.id
        JOIN users u ON u.id = cm.student_user_id
        LEFT JOIN exam_results r ON r.exam_id = ec.exam_id AND r.user_id = u.id
        WHERE ec.exam_id = $1
        ORDER BY c.name, u.full_name
      `, [examId]);
      return {
        exam,
        summary: {
          submissions: Number(summary.submissions),
          participants: exam.participantCount,
          average: Math.round(Number(summary.average) * 10) / 10,
          highest: Number(summary.highest),
          lowest: Number(summary.lowest),
          passRate: summary.submissions
            ? Math.round(summary.passed / summary.submissions * 100)
            : 0,
          passed: Number(summary.passed),
          completionPercent,
        },
        participants: participants.map((participant) => ({
          ...participant,
          score: participant.score === null ? null : Number(participant.score),
          correctCount: participant.correctCount === null ? null : Number(participant.correctCount),
          wrongCount: participant.wrongCount === null ? null : Number(participant.wrongCount),
          unansweredCount: participant.unansweredCount === null
            ? null
            : Number(participant.unansweredCount),
          kkm: Number(participant.kkm ?? 75),
          passed: participant.score !== null &&
            Number(participant.score) >= Number(participant.kkm ?? 75),
        })),
        questions,
      };
    },
    async listParticipants(profile) {
      const { rows } = await database.query(`
        SELECT DISTINCT e.id AS "examId", e.title AS "examTitle",
          u.id AS "studentId", u.full_name AS "fullName", u.email,
          c.name AS "className", r.score, r.id AS "resultId"
        FROM teacher_exam_settings tes
        JOIN exams e ON e.id = tes.exam_id
        JOIN exam_classes ec ON ec.exam_id = e.id
        JOIN classes c ON c.id = ec.class_id
        JOIN class_members cm ON cm.class_id = c.id
        JOIN users u ON u.id = cm.student_user_id
        LEFT JOIN exam_results r ON r.exam_id = e.id AND r.user_id = u.id
        WHERE tes.teacher_id = $1 AND tes.school_id = $2
        ORDER BY e.title, c.name, u.full_name
      `, [profile.id, profile.schoolId]);
      return rows.map((row) => ({
        ...row,
        score: row.score === null ? null : Number(row.score),
        status: row.resultId ? "Selesai" : "Belum mengerjakan",
      }));
    },
    async getResults(profile) {
      const { rows } = await database.query(`
        SELECT e.id AS "examId", e.title AS "examTitle", e.subject, tes.kkm,
          e.opens_at AS "opensAt", u.full_name AS "fullName", c.name AS "className",
          r.score, r.correct_count AS "correctCount", r.wrong_count AS "wrongCount",
          r.unanswered_count AS "unansweredCount", r.id AS "resultId"
        FROM teacher_exam_settings tes
        JOIN exams e ON e.id = tes.exam_id
        JOIN exam_classes ec ON ec.exam_id = e.id
        JOIN classes c ON c.id = ec.class_id
        JOIN class_members cm ON cm.class_id = c.id
        JOIN users u ON u.id = cm.student_user_id
        LEFT JOIN exam_results r ON r.exam_id = e.id AND r.user_id = u.id
        WHERE tes.teacher_id = $1 AND tes.school_id = $2
        ORDER BY e.created_at DESC, c.name, u.full_name
      `, [profile.id, profile.schoolId]);
      const results = rows.filter((row) => row.resultId).map((row) => ({
        ...row,
        score: Number(row.score),
        correctCount: Number(row.correctCount),
        wrongCount: Number(row.wrongCount),
        unansweredCount: Number(row.unansweredCount),
        kkm: Number(row.kkm),
        passed: Number(row.score) >= Number(row.kkm),
      }));
      const scores = results.map((result) => result.score);
      return {
        summary: {
          participants: rows.length,
          submissions: results.length,
          average: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length * 10) / 10 : 0,
          highest: scores.length ? Math.max(...scores) : 0,
          lowest: scores.length ? Math.min(...scores) : 0,
          passRate: scores.length
            ? Math.round(results.filter((result) => result.passed).length / scores.length * 100)
            : 0,
        },
        results,
      };
    },
  };
}
