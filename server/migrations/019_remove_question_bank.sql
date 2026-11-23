DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM questions) THEN
    RAISE EXCEPTION 'Cannot remove legacy questions table while it contains data';
  END IF;
  IF EXISTS (SELECT 1 FROM question_options) THEN
    RAISE EXCEPTION 'Cannot remove legacy question_options table while it contains data';
  END IF;
END
$$;

DROP VIEW IF EXISTS question_banks, exam_package_questions, exam_packages, exam_participants;

ALTER TABLE exam_questions
  DROP CONSTRAINT IF EXISTS exam_questions_imported_school_fk,
  DROP CONSTRAINT IF EXISTS exam_questions_imported_question_id_fkey,
  DROP CONSTRAINT IF EXISTS exam_questions_bank_question_id_fkey;

ALTER TABLE exam_questions
  DROP COLUMN IF EXISTS imported_question_id,
  DROP COLUMN IF EXISTS bank_question_id;

DROP TABLE question_bank_options;
DROP TABLE question_bank;
DROP TABLE question_options;
DROP TABLE questions;
