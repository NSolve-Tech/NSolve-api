CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  class_level TEXT NOT NULL,
  exam_type TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (topic IN (
    'Struktur Atom', 'Bilangan Kuantum', 'Ikatan Kimia',
    'Bentuk Molekul', 'Stoikiometri', 'Hidrokarbon'
  )),
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  option_e TEXT NOT NULL DEFAULT '',
  correct_answer CHAR(1) NOT NULL CHECK (correct_answer IN ('A', 'B', 'C', 'D', 'E')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (teacher_id, school_id) REFERENCES teachers(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id),
  UNIQUE (id, school_id)
);

CREATE INDEX questions_tenant_exam_level
  ON questions(school_id, subject_id, exam_type, class_level, academic_year);
CREATE INDEX questions_teacher_topic
  ON questions(teacher_id, topic, created_at DESC);

CREATE TABLE question_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_key CHAR(1) NOT NULL CHECK (option_key IN ('A', 'B', 'C', 'D', 'E')),
  option_text TEXT NOT NULL,
  position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 5),
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (question_id, option_key),
  UNIQUE (question_id, position)
);

ALTER TABLE teacher_exam_settings
  ADD COLUMN exam_type TEXT NOT NULL DEFAULT 'UTS';

ALTER TABLE exam_questions
  ADD COLUMN school_id TEXT REFERENCES schools(id),
  ADD COLUMN imported_question_id TEXT REFERENCES questions(id);

UPDATE exam_questions q
SET school_id = e.school_id
FROM exams e
WHERE e.id = q.exam_id;

ALTER TABLE exam_questions
  ADD CONSTRAINT exam_questions_school_exam_fk
    FOREIGN KEY (exam_id, school_id) REFERENCES exams(id, school_id),
  ADD CONSTRAINT exam_questions_imported_school_fk
    FOREIGN KEY (imported_question_id, school_id) REFERENCES questions(id, school_id);
