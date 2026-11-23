CREATE TABLE schools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, name),
  UNIQUE (id, school_id)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
  school_id TEXT REFERENCES schools(id),
  UNIQUE (id, school_id)
);

CREATE INDEX users_school_role ON users(school_id, role);

CREATE TABLE students (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL REFERENCES schools(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, school_id)
);

CREATE TABLE teachers (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  school_id TEXT NOT NULL REFERENCES schools(id),
  subject_id TEXT REFERENCES subjects(id),
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, school_id),
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id)
);

CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  grade_level TEXT NOT NULL,
  program TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, name),
  UNIQUE (id, school_id)
);

CREATE TABLE class_members (
  class_id TEXT NOT NULL,
  student_user_id TEXT NOT NULL UNIQUE,
  school_id TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (class_id, student_user_id),
  FOREIGN KEY (class_id, school_id) REFERENCES classes(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (student_user_id, school_id) REFERENCES students(user_id, school_id) ON DELETE CASCADE
);

CREATE INDEX class_members_school_student ON class_members(school_id, student_user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sessions_user_expires ON sessions(user_id, expires_at);

CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  school_id TEXT REFERENCES schools(id),
  subject_id TEXT REFERENCES subjects(id),
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  teacher_name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'active', 'closed')),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, school_id),
  FOREIGN KEY (subject_id, school_id) REFERENCES subjects(id, school_id)
);

CREATE INDEX exams_school_status_schedule ON exams(school_id, status, opens_at);

CREATE TABLE exam_questions (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'multiple_choice',
  UNIQUE (exam_id, position),
  UNIQUE (id, exam_id)
);

CREATE TABLE exam_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (question_id, position),
  UNIQUE (id, question_id)
);

CREATE TABLE exam_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  exam_id TEXT NOT NULL REFERENCES exams(id),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted')),
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  UNIQUE (id, exam_id, user_id)
);

CREATE INDEX exam_attempts_user_exam_status
  ON exam_attempts(user_id, exam_id, status);
CREATE UNIQUE INDEX exam_attempts_one_active
  ON exam_attempts(user_id, exam_id) WHERE status = 'in_progress';

CREATE TABLE exam_answers (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES exam_questions(id),
  selected_option_id TEXT REFERENCES exam_options(id),
  answer_text TEXT,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, question_id)
);

CREATE TABLE exam_results (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES exam_attempts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  exam_id TEXT NOT NULL REFERENCES exams(id),
  score DOUBLE PRECISION NOT NULL,
  correct_count INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL,
  unanswered_count INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX exam_results_user_created ON exam_results(user_id, created_at DESC);
CREATE INDEX exam_results_exam ON exam_results(exam_id);
