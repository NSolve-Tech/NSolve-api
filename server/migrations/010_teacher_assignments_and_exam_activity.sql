CREATE TABLE teacher_classes (
  teacher_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (teacher_id, class_id),
  FOREIGN KEY (teacher_id, school_id)
    REFERENCES teachers(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (class_id, school_id)
    REFERENCES classes(id, school_id) ON DELETE CASCADE
);

CREATE INDEX teacher_classes_school_class
  ON teacher_classes(school_id, class_id);

ALTER TABLE exam_attempts
  ADD COLUMN violation_count INTEGER NOT NULL DEFAULT 0 CHECK (violation_count >= 0),
  ADD COLUMN locked_until TIMESTAMPTZ,
  ADD COLUMN disqualified_at TIMESTAMPTZ;

CREATE TABLE exam_activity_events (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL,
  attempt_id TEXT,
  user_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'tab_hidden', 'window_blur', 'fullscreen_exit', 'print_screen'
  )),
  violation_number INTEGER NOT NULL CHECK (violation_number >= 1),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (exam_id, school_id)
    REFERENCES exams(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, school_id)
    REFERENCES users(id, school_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id, exam_id, user_id)
    REFERENCES exam_attempts(id, exam_id, user_id) ON DELETE CASCADE
);

CREATE INDEX exam_activity_school_occurred
  ON exam_activity_events(school_id, occurred_at DESC);
