ALTER TABLE exam_activity_events
  ADD COLUMN question_number INTEGER
    CHECK (question_number IS NULL OR question_number >= 1);
