ALTER TABLE teacher_exam_settings
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'public'));

CREATE INDEX teacher_exam_settings_visibility
  ON teacher_exam_settings(school_id, visibility, workflow_status);
