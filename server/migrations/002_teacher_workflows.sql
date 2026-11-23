CREATE TABLE question_bank (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  school_id TEXT NOT NULL REFERENCES schools(id),
  subject_id TEXT REFERENCES subjects(id),
  academic_year TEXT NOT NULL,
  subject TEXT NOT NULL,
  grade_level TEXT NOT NULL,
  chapter TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('mudah', 'sedang', 'sulit')),
  type TEXT NOT NULL CHECK (type IN (
    'multiple_choice', 'multiple_choice_complex', 'true_false',
    'matching', 'short_answer', 'essay'
  )),
  prompt TEXT NOT NULL,
  answer_key TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (teacher_id, school_id) REFERENCES teachers(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id)
);

CREATE INDEX question_bank_tenant_filters
  ON question_bank(school_id, subject, grade_level, chapter, created_at DESC);
CREATE INDEX question_bank_teacher_created
  ON question_bank(teacher_id, created_at DESC);

CREATE TABLE question_bank_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES question_bank(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (question_id, position)
);

CREATE TABLE teacher_exam_settings (
  exam_id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  school_id TEXT NOT NULL REFERENCES schools(id),
  academic_year TEXT NOT NULL,
  semester TEXT NOT NULL CHECK (semester IN ('Ganjil', 'Genap')),
  grade_level TEXT NOT NULL,
  mc_question_count INTEGER NOT NULL CHECK (mc_question_count >= 0),
  essay_question_count INTEGER NOT NULL CHECK (essay_question_count >= 0),
  randomize_questions BOOLEAN NOT NULL DEFAULT TRUE,
  randomize_options BOOLEAN NOT NULL DEFAULT TRUE,
  workflow_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (workflow_status IN ('draft', 'scheduled', 'active', 'completed')),
  FOREIGN KEY (exam_id, school_id) REFERENCES exams(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id, school_id) REFERENCES teachers(id, school_id)
);

CREATE INDEX teacher_exam_settings_school_status
  ON teacher_exam_settings(school_id, workflow_status);
CREATE INDEX teacher_exam_settings_teacher_status
  ON teacher_exam_settings(teacher_id, workflow_status);

CREATE TABLE exam_classes (
  exam_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  PRIMARY KEY (exam_id, class_id),
  FOREIGN KEY (exam_id, school_id) REFERENCES exams(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE CASCADE
);

ALTER TABLE exam_questions
  ADD COLUMN bank_question_id TEXT REFERENCES question_bank(id) ON DELETE SET NULL,
  ADD COLUMN points DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (points > 0),
  ADD COLUMN requires_manual_grading BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE exam_attempts
  ADD COLUMN school_id TEXT REFERENCES schools(id);

UPDATE exam_attempts a
SET school_id = e.school_id
FROM exams e
WHERE e.id = a.exam_id;

ALTER TABLE exam_attempts
  ADD CONSTRAINT exam_attempts_school_exam_fk
    FOREIGN KEY (exam_id, school_id) REFERENCES exams(id, school_id),
  ADD CONSTRAINT exam_attempts_school_user_fk
    FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id);

ALTER TABLE exam_results
  ADD COLUMN school_id TEXT REFERENCES schools(id);

UPDATE exam_results r
SET school_id = e.school_id
FROM exams e
WHERE e.id = r.exam_id;

ALTER TABLE exam_results
  ADD CONSTRAINT exam_results_school_exam_fk
    FOREIGN KEY (exam_id, school_id) REFERENCES exams(id, school_id),
  ADD CONSTRAINT exam_results_school_user_fk
    FOREIGN KEY (user_id, school_id) REFERENCES users(id, school_id);

CREATE TABLE exam_question_analytics (
  exam_question_id TEXT PRIMARY KEY REFERENCES exam_questions(id) ON DELETE CASCADE,
  average_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  correct_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  response_count INTEGER NOT NULL DEFAULT 0
);
