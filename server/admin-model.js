import { randomUUID } from "node:crypto";
import { withTransaction } from "./database.js";

export function createAdminModel(database) {
  async function listTeacherAssignments(schoolId) {
    const [{ rows: teachers }, { rows: classes }] = await Promise.all([
      database.query(`
        SELECT t.id, t.full_name AS "fullName", t.subject,
          t.position_title AS "positionTitle",
          COALESCE(json_agg(json_build_object(
            'id', c.id, 'name', c.name
          ) ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL), '[]'::json) AS classes
        FROM teachers t
        LEFT JOIN teacher_classes tc
          ON tc.teacher_id = t.id AND tc.school_id = t.school_id
        LEFT JOIN classes c ON c.id = tc.class_id AND c.school_id = tc.school_id
        WHERE t.school_id = $1
        GROUP BY t.id
        ORDER BY t.full_name
      `, [schoolId]),
      database.query(`
        SELECT c.id, c.name, c.grade_level AS "gradeLevel",
          COUNT(cm.student_user_id)::INTEGER AS "studentCount"
        FROM classes c
        LEFT JOIN class_members cm ON cm.class_id = c.id
        WHERE c.school_id = $1
        GROUP BY c.id
        ORDER BY
          CASE c.grade_level WHEN 'X' THEN 1 WHEN 'XI' THEN 2 WHEN 'XII' THEN 3 ELSE 4 END,
          CASE
            WHEN c.name ~ ' [0-9]+$'
            THEN CAST(substring(c.name from '[0-9]+$') AS INTEGER)
            ELSE 999
          END,
          c.name
      `, [schoolId]),
    ]);
    return { teachers, classes };
  }

  async function setTeacherClasses(schoolId, teacherId, classIds) {
    await withTransaction(database, async (client) => {
      const { rows: [teacher] } = await client.query(
        "SELECT id FROM teachers WHERE id = $1 AND school_id = $2",
        [teacherId, schoolId],
      );
      if (!teacher) throw new Error("TEACHER_NOT_FOUND");

      const uniqueClassIds = [...new Set(classIds)];
      const { rows: classes } = uniqueClassIds.length
        ? await client.query(`
          SELECT id FROM classes
          WHERE school_id = $1 AND id = ANY($2::text[])
        `, [schoolId, uniqueClassIds])
        : { rows: [] };
      if (classes.length !== uniqueClassIds.length) throw new Error("CLASS_INVALID");

      await client.query(
        "DELETE FROM teacher_classes WHERE teacher_id = $1 AND school_id = $2",
        [teacherId, schoolId],
      );
      for (const classId of uniqueClassIds) {
        await client.query(`
          INSERT INTO teacher_classes (teacher_id, class_id, school_id)
          VALUES ($1, $2, $3)
        `, [teacherId, classId, schoolId]);
      }
    });
    return listTeacherAssignments(schoolId);
  }

  async function listExamActivity(schoolId) {
    const { rows } = await database.query(`
      SELECT event.id, event.exam_id AS "examId", event.attempt_id AS "attemptId",
        event.user_id AS "studentId", u.full_name AS "studentName",
        e.title AS "examTitle", event.event_type AS "eventType",
        event.violation_number AS "violationNumber",
        event.question_number AS "questionNumber",
        (
          event.attempt_id IS NOT NULL
          AND event.violation_number >= 3
          AND EXISTS (
            SELECT 1 FROM exam_results result
            WHERE result.attempt_id = event.attempt_id
          )
        ) AS "autoSubmitted",
        event.occurred_at AS "occurredAt",
        (
          SELECT c.name
          FROM class_members cm
          JOIN classes c ON c.id = cm.class_id
          WHERE cm.student_user_id = event.user_id AND c.school_id = event.school_id
          LIMIT 1
        ) AS "className"
      FROM exam_activity_events event
      JOIN users u ON u.id = event.user_id AND u.school_id = event.school_id
      JOIN exams e ON e.id = event.exam_id AND e.school_id = event.school_id
      WHERE event.school_id = $1
      ORDER BY event.occurred_at DESC
      LIMIT 100
    `, [schoolId]);
    return rows;
  }

  async function listActiveExamSessions(schoolId) {
    const { rows } = await database.query(`
      SELECT a.id AS "attemptId", a.user_id AS "studentId",
        u.full_name AS "studentName", e.id AS "examId", e.title AS "examTitle",
        (
          SELECT c.name
          FROM exam_classes ec
          JOIN class_members cm ON cm.class_id = ec.class_id
          JOIN classes c ON c.id = ec.class_id
          WHERE ec.exam_id = a.exam_id AND cm.student_user_id = a.user_id
            AND ec.school_id = a.school_id
          ORDER BY c.name
          LIMIT 1
        ) AS "className",
        a.started_at AS "startedAt", a.expires_at AS "expiresAt",
        a.violation_count AS "violationCount", a.locked_until AS "lockedUntil",
        a.disqualified_at AS "disqualifiedAt",
        latest.event_type AS "lastEventType",
        latest.question_number AS "lastQuestionNumber",
        latest.occurred_at AS "lastEventAt"
      FROM exam_attempts a
      JOIN users u ON u.id = a.user_id AND u.school_id = a.school_id
      JOIN exams e ON e.id = a.exam_id AND e.school_id = a.school_id
      LEFT JOIN LATERAL (
        SELECT event_type, question_number, occurred_at
        FROM exam_activity_events
        WHERE attempt_id = a.id
        ORDER BY occurred_at DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE a.school_id = $1 AND a.status = 'in_progress'
        AND a.expires_at > NOW()
      ORDER BY a.started_at DESC
      LIMIT 100
    `, [schoolId]);
    return rows;
  }

  async function listUsers(schoolId, role) {
    const { rows } = await database.query(`
      SELECT u.id, u.full_name AS "fullName", u.email, u.role,
        u.is_active AS "isActive", u.created_at AS "createdAt",
        school.name AS "schoolName", c.id AS "classId", c.name AS "className",
        t.id AS "teacherId", t.subject, t.position_title AS "positionTitle",
        (
          SELECT COALESCE(json_agg(json_build_object(
            'id', assigned.id, 'name', assigned.name, 'gradeLevel', assigned.grade_level
          )
            ORDER BY assigned.name), '[]'::json)
          FROM teacher_classes tc
          JOIN classes assigned ON assigned.id = tc.class_id AND assigned.school_id = tc.school_id
          WHERE tc.teacher_id = t.id AND tc.school_id = u.school_id
        ) AS "teacherClasses"
      FROM users u
      LEFT JOIN schools school ON school.id = u.school_id
      LEFT JOIN class_members cm ON cm.student_user_id = u.id
      LEFT JOIN classes c ON c.id = cm.class_id
      LEFT JOIN teachers t ON t.user_id = u.id AND t.school_id = u.school_id
      WHERE u.school_id = $1 AND ($2::text IS NULL OR u.role = $2)
      ORDER BY u.role, u.full_name
    `, [schoolId, role ?? null]);
    return rows;
  }

  async function updateUser(schoolId, userId, input) {
    return withTransaction(database, async (client) => {
      const { rows: [user] } = await client.query(`
        SELECT id, role, school_id, full_name, email, is_active
        FROM users WHERE id = $1 AND school_id = $2 FOR UPDATE
      `, [userId, schoolId]);
      if (!user) throw new Error("USER_NOT_FOUND");
      const nextRole = input.role ?? user.role;
      const nextName = input.fullName ?? user.full_name;
      const nextEmail = input.email ?? user.email;
      const isActive = input.isActive ?? user.is_active;

      if (nextRole === "student") {
        if (user.role !== "student") {
          await client.query("UPDATE teachers SET user_id = NULL WHERE user_id = $1", [userId]);
          await client.query(`
            INSERT INTO students (user_id, school_id, created_at)
            VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET school_id = EXCLUDED.school_id
          `, [userId, schoolId]);
        }
        if (input.classId) {
          const { rows: [schoolClass] } = await client.query(
            "SELECT id FROM classes WHERE id = $1 AND school_id = $2",
            [input.classId, schoolId],
          );
          if (!schoolClass) throw new Error("CLASS_INVALID");
          await client.query(`
            INSERT INTO class_members (class_id, student_user_id, school_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (student_user_id) DO UPDATE SET
              class_id = EXCLUDED.class_id, school_id = EXCLUDED.school_id,
              assigned_at = NOW()
          `, [input.classId, userId, schoolId]);
        } else if (user.role !== "student") {
          throw new Error("CLASS_REQUIRED");
        }
      } else {
        await client.query("DELETE FROM class_members WHERE student_user_id = $1", [userId]);
        await client.query("DELETE FROM students WHERE user_id = $1", [userId]);
      }

      if (nextRole === "teacher") {
        const subjectName = input.subject?.trim() || "Umum";
        const { rows: [subject] } = await client.query(`
          INSERT INTO subjects (id, school_id, name)
          VALUES ($1, $2, $3)
          ON CONFLICT (school_id, name) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `, [randomUUID(), schoolId, subjectName]);
        const { rows: [teacher] } = await client.query(
          "SELECT id FROM teachers WHERE user_id = $1 AND school_id = $2",
          [userId, schoolId],
        );
        if (teacher) {
          await client.query(`
            UPDATE teachers SET full_name = $2, subject_id = $3, subject = $4,
              position_title = $5 WHERE id = $1
          `, [teacher.id, nextName, subject.id, subjectName, input.positionTitle?.trim() || "Guru"]);
          if (Array.isArray(input.classIds)) {
            const classIds = [...new Set(input.classIds)];
            const { rows: classes } = classIds.length
              ? await client.query(
                "SELECT id FROM classes WHERE school_id = $1 AND id = ANY($2::text[])",
                [schoolId, classIds],
              )
              : { rows: [] };
            if (classes.length !== classIds.length) throw new Error("CLASS_INVALID");
            await client.query(
              "DELETE FROM teacher_classes WHERE teacher_id = $1 AND school_id = $2",
              [teacher.id, schoolId],
            );
            for (const classId of classIds) {
              await client.query(
                "INSERT INTO teacher_classes (teacher_id, class_id, school_id) VALUES ($1, $2, $3)",
                [teacher.id, classId, schoolId],
              );
            }
          }
        } else {
          const teacherId = randomUUID();
          await client.query(`
            INSERT INTO teachers (
              id, user_id, full_name, school_id, subject_id, subject, position_title
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            teacherId, userId, nextName, schoolId, subject.id, subjectName,
            input.positionTitle?.trim() || "Guru",
          ]);
          for (const classId of [...new Set(input.classIds ?? [])]) {
            const { rows: [schoolClass] } = await client.query(
              "SELECT id FROM classes WHERE id = $1 AND school_id = $2",
              [classId, schoolId],
            );
            if (!schoolClass) throw new Error("CLASS_INVALID");
            await client.query(
              "INSERT INTO teacher_classes (teacher_id, class_id, school_id) VALUES ($1, $2, $3)",
              [teacherId, classId, schoolId],
            );
          }
        }
      } else {
        await client.query("UPDATE teachers SET user_id = NULL WHERE user_id = $1", [userId]);
      }

      await client.query(`
        UPDATE users SET full_name = $2, email = $3, role = $4, is_active = $5
        WHERE id = $1
      `, [userId, nextName, nextEmail, nextRole, isActive]);
      return true;
    });
  }

  async function createUser(schoolId, input) {
    const userId = randomUUID();
    const teacherId = input.role === "teacher" ? randomUUID() : null;
    const classIds = [...new Set(input.classIds ?? [])];
    const user = await withTransaction(database, async (client) => {
      const { rows: [school] } = await client.query(
        "SELECT id FROM schools WHERE id = $1 AND is_active = TRUE FOR UPDATE",
        [schoolId],
      );
      if (!school) throw new Error("SCHOOL_NOT_AVAILABLE");
      if (input.role === "student") {
        const { rows: [studentClass] } = await client.query(
          "SELECT id FROM classes WHERE id = $1 AND school_id = $2",
          [input.classId, schoolId],
        );
        if (!studentClass) throw new Error("CLASS_INVALID");
      }
      let subject = null;
      if (teacherId) {
        const { rows: [row] } = await client.query(`
          INSERT INTO subjects (id, school_id, name)
          VALUES ($1, $2, $3)
          ON CONFLICT (school_id, name) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `, [randomUUID(), schoolId, input.subject]);
        subject = row;
        const { rows: classes } = classIds.length
          ? await client.query(
            "SELECT id FROM classes WHERE school_id = $1 AND id = ANY($2::text[])",
            [schoolId, classIds],
          )
          : { rows: [] };
        if (classes.length !== classIds.length) throw new Error("CLASS_INVALID");
      }
      await client.query(`
        INSERT INTO users (
          id, full_name, email, password_salt, password_hash, created_at, role, school_id
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
      `, [
        userId, input.fullName, input.email, input.passwordSalt,
        input.passwordHash, input.role, schoolId,
      ]);
      if (teacherId) {
        await client.query(`
          INSERT INTO teachers (
            id, user_id, full_name, school_id, subject_id, subject, position_title
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          teacherId, userId, input.fullName, schoolId,
          subject.id, input.subject, input.positionTitle,
        ]);
        for (const classId of classIds) {
          await client.query(`
            INSERT INTO teacher_classes (teacher_id, class_id, school_id)
            VALUES ($1, $2, $3)
          `, [teacherId, classId, schoolId]);
        }
      }
      if (input.role === "student") {
        await client.query(`
          INSERT INTO students (user_id, school_id, created_at)
          VALUES ($1, $2, NOW())
        `, [userId, schoolId]);
        await client.query(`
          INSERT INTO class_members (class_id, student_user_id, school_id, assigned_at)
          VALUES ($1, $2, $3, NOW())
        `, [input.classId, userId, schoolId]);
      }
      return userId;
    });
    return (await listUsers(schoolId)).find((item) => item.id === user) ?? null;
  }

  async function resetUserPassword(schoolId, userId, {
    passwordSalt,
    passwordHash,
    actorId,
    actorName,
  }) {
    return withTransaction(database, async (client) => {
      const { rows: [target] } = await client.query(`
        SELECT full_name FROM users
        WHERE id = $1 AND school_id = $2
        FOR UPDATE
      `, [userId, schoolId]);
      if (!target) return null;
      await client.query(`
        UPDATE users SET password_salt = $3, password_hash = $4
        WHERE id = $1 AND school_id = $2
      `, [userId, schoolId, passwordSalt, passwordHash]);
      await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
      const { rows: [log] } = await client.query(`
        INSERT INTO admin_password_reset_logs (
          id, school_id, actor_user_id, actor_name, target_user_id, target_name
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING reset_at AS "resetAt"
      `, [randomUUID(), schoolId, actorId, actorName, userId, target.full_name]);
      return log;
    });
  }

  async function listPasswordResetLogs(schoolId, userId) {
    const { rows } = await database.query(`
      SELECT id, actor_user_id AS "actorId", actor_name AS "actorName",
        target_user_id AS "targetId", target_name AS "targetName",
        reset_at AS "resetAt"
      FROM admin_password_reset_logs
      WHERE school_id = $1 AND target_user_id = $2
      ORDER BY reset_at DESC
      LIMIT 50
    `, [schoolId, userId]);
    return rows;
  }

  async function deleteExams(client, schoolId, examIds) {
    const ids = [...new Set(examIds)];
    if (!ids.length) return;
    await client.query(`
      DELETE FROM remedial_requests
      WHERE school_id = $1
        AND (exam_id = ANY($2::text[]) OR scheduled_exam_id = ANY($2::text[]))
    `, [schoolId, ids]);
    await client.query(
      "DELETE FROM exam_results WHERE school_id = $1 AND exam_id = ANY($2::text[])",
      [schoolId, ids],
    );
    await client.query(
      "DELETE FROM exam_attempts WHERE school_id = $1 AND exam_id = ANY($2::text[])",
      [schoolId, ids],
    );
    await client.query(
      "DELETE FROM exams WHERE school_id = $1 AND id = ANY($2::text[])",
      [schoolId, ids],
    );
  }

  async function deleteTeacherData(client, schoolId, teacherIds) {
    if (!teacherIds.length) return;
    const { rows: exams } = await client.query(`
      SELECT exam_id AS id FROM teacher_exam_settings
      WHERE school_id = $1 AND teacher_id = ANY($2::text[])
    `, [schoolId, teacherIds]);
    await deleteExams(client, schoolId, exams.map((exam) => exam.id));
    await client.query(
      "DELETE FROM remedial_requests WHERE school_id = $1 AND teacher_id = ANY($2::text[])",
      [schoolId, teacherIds],
    );
    await client.query(
      "DELETE FROM teachers WHERE school_id = $1 AND id = ANY($2::text[])",
      [schoolId, teacherIds],
    );
  }

  async function deleteUser(schoolId, userId) {
    return withTransaction(database, async (client) => {
      const { rows: [user] } = await client.query(`
        SELECT id, role FROM users
        WHERE id = $1 AND school_id = $2
        FOR UPDATE
      `, [userId, schoolId]);
      if (!user) return false;
      await client.query(
        "DELETE FROM exam_results WHERE school_id = $1 AND user_id = $2",
        [schoolId, userId],
      );
      await client.query(
        "DELETE FROM exam_attempts WHERE school_id = $1 AND user_id = $2",
        [schoolId, userId],
      );
      await client.query(
        "DELETE FROM admin_password_reset_logs WHERE school_id = $1 AND target_user_id = $2",
        [schoolId, userId],
      );
      const { rows: teachers } = await client.query(`
        SELECT id FROM teachers
        WHERE school_id = $1 AND user_id = $2
        FOR UPDATE
      `, [schoolId, userId]);
      if (teachers.length) {
        await deleteTeacherData(client, schoolId, teachers.map((teacher) => teacher.id));
      }
      const { rows } = await client.query(
        "DELETE FROM users WHERE id = $1 AND school_id = $2 RETURNING id",
        [userId, schoolId],
      );
      return rows.length > 0;
    });
  }

  async function listExams(schoolId) {
    const { rows } = await database.query(`
      SELECT e.id, e.title, e.subject, e.status, e.opens_at AS "opensAt",
        e.closes_at AS "closesAt", e.created_at AS "createdAt",
        e.code, e.published_at AS "publishedAt",
        t.full_name AS "teacherName",
        COALESCE(array_agg(DISTINCT c.name) FILTER (WHERE c.id IS NOT NULL), '{}') AS classes,
        COUNT(DISTINCT q.id)::INTEGER AS "questionCount"
      FROM exams e
      LEFT JOIN teacher_exam_settings tes ON tes.exam_id = e.id
      LEFT JOIN teachers t ON t.id = tes.teacher_id
      LEFT JOIN exam_classes ec ON ec.exam_id = e.id
      LEFT JOIN classes c ON c.id = ec.class_id
      LEFT JOIN exam_questions q ON q.exam_id = e.id
      WHERE e.school_id = $1
      GROUP BY e.id, t.full_name
      ORDER BY e.created_at DESC
    `, [schoolId]);
    return rows;
  }

  async function updateExamToken(schoolId, examId, code) {
    return withTransaction(database, async (client) => {
      const { rows: [exam] } = await client.query(`
        SELECT id FROM exams
        WHERE id = $1 AND school_id = $2 AND published_at IS NOT NULL
        FOR UPDATE
      `, [examId, schoolId]);
      if (!exam) return null;
      const { rows: duplicateCodes } = await client.query(
        "SELECT 1 FROM exams WHERE code = $1 AND id <> $2",
        [code, examId],
      );
      if (duplicateCodes.length) throw new Error("EXAM_TOKEN_TAKEN");
      const { rows: [updated] } = await client.query(`
        UPDATE exams SET code = $1
        WHERE id = $2 AND school_id = $3
        RETURNING id, code
      `, [code, examId, schoolId]);
      return updated;
    });
  }

  async function listSubjects(schoolId) {
    const { rows } = await database.query(`
      SELECT s.id, s.name, COUNT(DISTINCT t.id)::INTEGER AS "teacherCount"
      FROM subjects s
      LEFT JOIN teachers t ON t.subject_id = s.id
      WHERE s.school_id = $1
      GROUP BY s.id ORDER BY s.name
    `, [schoolId]);
    return rows;
  }

  async function listClasses(schoolId) {
    const { rows } = await database.query(`
      SELECT c.id, c.name, c.grade_level AS "gradeLevel",
        COUNT(DISTINCT cm.student_user_id)::INTEGER AS "studentCount",
        COUNT(DISTINCT tc.teacher_id)::INTEGER AS "teacherCount"
      FROM classes c
      LEFT JOIN class_members cm ON cm.class_id = c.id
      LEFT JOIN teacher_classes tc ON tc.class_id = c.id AND tc.school_id = c.school_id
      WHERE c.school_id = $1
      GROUP BY c.id
      ORDER BY
        CASE c.grade_level WHEN 'X' THEN 1 WHEN 'XI' THEN 2 WHEN 'XII' THEN 3 ELSE 4 END,
        CASE
          WHEN c.name ~ ' [0-9]+$'
          THEN CAST(substring(c.name from '[0-9]+$') AS INTEGER)
          ELSE 999
        END,
        c.name
    `, [schoolId]);
    return rows;
  }

  async function saveSubject(schoolId, subjectId, name) {
    const id = subjectId ?? randomUUID();
    const { rows } = await database.query(`
      INSERT INTO subjects (id, school_id, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (school_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name
    `, [id, schoolId, name]);
    return rows[0];
  }

  async function deleteSubject(schoolId, subjectId) {
    return withTransaction(database, async (client) => {
      const { rows: [subject] } = await client.query(`
        SELECT id FROM subjects
        WHERE id = $1 AND school_id = $2
        FOR UPDATE
      `, [subjectId, schoolId]);
      if (!subject) return false;
      const { rows: exams } = await client.query(
        "SELECT id FROM exams WHERE subject_id = $1 AND school_id = $2",
        [subjectId, schoolId],
      );
      await deleteExams(client, schoolId, exams.map((exam) => exam.id));
      await client.query(`
        UPDATE teachers SET subject_id = NULL, subject = 'Umum'
        WHERE subject_id = $1 AND school_id = $2
      `, [subjectId, schoolId]);
      const { rows } = await client.query(
        "DELETE FROM subjects WHERE id = $1 AND school_id = $2 RETURNING id",
        [subjectId, schoolId],
      );
      return rows.length > 0;
    });
  }

  async function saveClass(schoolId, classId, { name, gradeLevel }) {
    const id = classId ?? randomUUID();
    const { rows } = await database.query(`
      INSERT INTO classes (id, school_id, name, grade_level, program)
      VALUES ($1, $2, $3, $4, '')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, grade_level = EXCLUDED.grade_level
      RETURNING id, name, grade_level AS "gradeLevel"
    `, [id, schoolId, name, gradeLevel]);
    return rows[0];
  }

  async function deleteClass(schoolId, classId) {
    const { rows } = await database.query(
      "DELETE FROM classes WHERE id = $1 AND school_id = $2 RETURNING id",
      [classId, schoolId],
    );
    return rows.length > 0;
  }

  async function getSchool(schoolId) {
    const { rows: [school] } = await database.query(
      `SELECT s.id, s.name, s.address, s.email, s.is_active AS "isActive",
        (SELECT COUNT(*)::INTEGER FROM teachers t WHERE t.school_id = s.id) AS "teacherCount",
        (SELECT COUNT(*)::INTEGER FROM students st WHERE st.school_id = s.id) AS "studentCount",
        (SELECT COUNT(*)::INTEGER FROM classes c WHERE c.school_id = s.id) AS "classCount"
       FROM schools s WHERE s.id = $1`,
      [schoolId],
    );
    return school ?? null;
  }

  async function listSchools() {
    const { rows } = await database.query(
      `SELECT s.id, s.name, s.address, s.email, s.is_active AS "isActive",
        (SELECT COUNT(*)::INTEGER FROM teachers t WHERE t.school_id = s.id) AS "teacherCount",
        (SELECT COUNT(*)::INTEGER FROM students st WHERE st.school_id = s.id) AS "studentCount",
        (SELECT COUNT(*)::INTEGER FROM classes c WHERE c.school_id = s.id) AS "classCount"
       FROM schools s ORDER BY s.name`,
    );
    return rows;
  }

  async function createSchool({ id, name, address, email }) {
    await withTransaction(database, async (client) => {
      await client.query(`
        INSERT INTO schools (id, name, address, email)
        VALUES ($1, $2, $3, $4)
      `, [id, name, address, email]);
      await client.query(`
        INSERT INTO classes (id, school_id, name, grade_level, program)
        SELECT
          'class-' || md5(s.id) || '-' || lower(levels.grade_level) || '-' || class_numbers.number,
          s.id,
          CASE
            WHEN s.name = 'SMAN 2 Kota Lubuk Linggau' AND levels.grade_level = 'XI'
            THEN 'XI F ' || class_numbers.number
            ELSE levels.grade_level || ' ' || class_numbers.number
          END,
          levels.grade_level,
          ''
        FROM schools s
        CROSS JOIN (VALUES ('X', 12), ('XI', 11), ('XII', 11))
          AS levels(grade_level, class_count)
        CROSS JOIN LATERAL generate_series(1, levels.class_count) AS class_numbers(number)
        WHERE s.id = $1
        ON CONFLICT (school_id, name) DO NOTHING
      `, [id]);
    });
    return getSchool(id);
  }

  async function updateSchool(schoolId, { name, address, email, isActive }) {
    return withTransaction(database, async (client) => {
      const { rows: [school] } = await client.query(`
        UPDATE schools
        SET name = $2, address = $3, email = $4, is_active = $5
        WHERE id = $1
        RETURNING id
      `, [schoolId, name, address, email, isActive]);
      if (!school) return null;
      if (!isActive) {
        await client.query(`
          DELETE FROM sessions
          WHERE user_id IN (SELECT id FROM users WHERE school_id = $1)
        `, [schoolId]);
      }
      return schoolId;
    }).then((updatedId) => updatedId ? getSchool(updatedId) : null);
  }

  async function deleteSchool(schoolId) {
    return withTransaction(database, async (client) => {
      const { rows: [school] } = await client.query(
        "SELECT id FROM schools WHERE id = $1 FOR UPDATE",
        [schoolId],
      );
      if (!school) return { deleted: false, notFound: true };
      const { rows: exams } = await client.query(
        "SELECT id FROM exams WHERE school_id = $1",
        [schoolId],
      );
      await deleteExams(client, schoolId, exams.map((exam) => exam.id));
      await client.query("DELETE FROM remedial_requests WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM exam_activity_events WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM exam_results WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM exam_attempts WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM teacher_exam_settings WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM admin_password_reset_logs WHERE school_id = $1", [schoolId]);
      await client.query(`
        DELETE FROM sessions
        WHERE user_id IN (SELECT id FROM users WHERE school_id = $1)
      `, [schoolId]);
      await client.query("DELETE FROM teachers WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM users WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM classes WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM subjects WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM schools WHERE id = $1", [schoolId]);
      return { deleted: true };
    });
  }

  async function updateAdminProfile(userId, { fullName, email }) {
    const { rows } = await database.query(`
      UPDATE users SET full_name = $2, email = $3
      WHERE id = $1 AND role = 'admin'
      RETURNING id, full_name AS "fullName", email
    `, [userId, fullName, email]);
    return rows[0] ?? null;
  }

  return {
    async listTeacherAssignments(schoolId) {
      return listTeacherAssignments(schoolId);
    },
    async setTeacherClasses(schoolId, teacherId, classIds) {
      return setTeacherClasses(schoolId, teacherId, classIds);
    },
    async listExamActivity(schoolId) {
      return listExamActivity(schoolId);
    },
    async listActiveExamSessions(schoolId) {
      return listActiveExamSessions(schoolId);
    },
    async listUsers(schoolId, role) {
      return listUsers(schoolId, role);
    },
    async updateUser(schoolId, userId, input) {
      return updateUser(schoolId, userId, input);
    },
    async createUser(schoolId, input) {
      return createUser(schoolId, input);
    },
    async resetUserPassword(schoolId, userId, input) {
      return resetUserPassword(schoolId, userId, input);
    },
    async listPasswordResetLogs(schoolId, userId) {
      return listPasswordResetLogs(schoolId, userId);
    },
    async deleteUser(schoolId, userId) {
      return deleteUser(schoolId, userId);
    },
    async listExams(schoolId) {
      return listExams(schoolId);
    },
    async updateExamToken(schoolId, examId, code) {
      return updateExamToken(schoolId, examId, code);
    },
    async listSubjects(schoolId) {
      return listSubjects(schoolId);
    },
    async listClasses(schoolId) {
      return listClasses(schoolId);
    },
    async saveSubject(schoolId, subjectId, name) {
      return saveSubject(schoolId, subjectId, name);
    },
    async deleteSubject(schoolId, subjectId) {
      return deleteSubject(schoolId, subjectId);
    },
    async saveClass(schoolId, classId, input) {
      return saveClass(schoolId, classId, input);
    },
    async deleteClass(schoolId, classId) {
      return deleteClass(schoolId, classId);
    },
    async getSchool(schoolId) {
      return getSchool(schoolId);
    },
    async listSchools() {
      return listSchools();
    },
    async createSchool(input) {
      return createSchool(input);
    },
    async updateSchool(schoolId, input) {
      return updateSchool(schoolId, input);
    },
    async deleteSchool(schoolId) {
      return deleteSchool(schoolId);
    },
    async updateAdminProfile(userId, input) {
      return updateAdminProfile(userId, input);
    },
  };
}
