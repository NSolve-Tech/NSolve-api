ALTER TABLE teacher_exam_settings
  ADD COLUMN kkm SMALLINT NOT NULL DEFAULT 75
    CHECK (kkm BETWEEN 0 AND 100);

CREATE TABLE remedial_requests (
  id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL UNIQUE REFERENCES exam_results(id) ON DELETE CASCADE,
  exam_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  school_id TEXT NOT NULL REFERENCES schools(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'scheduled')),
  scheduled_exam_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  FOREIGN KEY (exam_id, school_id)
    REFERENCES exams(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, school_id)
    REFERENCES users(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id, school_id)
    REFERENCES teachers(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (scheduled_exam_id, school_id)
    REFERENCES exams(id, school_id)
);

CREATE INDEX remedial_requests_teacher_status
  ON remedial_requests(teacher_id, status, created_at DESC);
