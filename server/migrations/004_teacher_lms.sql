ALTER TABLE teacher_exam_settings
  ADD COLUMN auto_grade BOOLEAN NOT NULL DEFAULT TRUE;

CREATE VIEW question_banks AS
  SELECT * FROM question_bank;

CREATE VIEW exam_packages AS
  SELECT e.id, e.school_id, tes.teacher_id, e.subject_id, e.title, e.subject,
    e.description, e.duration_minutes, e.opens_at, e.closes_at,
    tes.academic_year, tes.semester, tes.grade_level, tes.workflow_status AS status,
    tes.randomize_questions, tes.randomize_options, tes.auto_grade
  FROM exams e
  JOIN teacher_exam_settings tes ON tes.exam_id = e.id;

CREATE VIEW exam_package_questions AS
  SELECT exam_id, bank_question_id AS question_id, position, points
  FROM exam_questions
  WHERE bank_question_id IS NOT NULL;

CREATE VIEW exam_participants AS
  SELECT ec.exam_id, ec.school_id, cm.student_user_id AS user_id,
    cm.class_id, r.id AS result_id, r.score
  FROM exam_classes ec
  JOIN class_members cm ON cm.class_id = ec.class_id
  LEFT JOIN exam_results r
    ON r.exam_id = ec.exam_id AND r.user_id = cm.student_user_id;
