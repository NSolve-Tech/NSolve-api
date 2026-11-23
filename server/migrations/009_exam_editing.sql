ALTER TABLE exam_questions
  ADD COLUMN answer_key TEXT NOT NULL DEFAULT '';

UPDATE exam_questions eq
SET answer_key = qb.answer_key
FROM question_bank qb
WHERE eq.bank_question_id = qb.id;

DELETE FROM exams e
WHERE e.id IN (
  'exam-kimia-uh-01',
  'exam-fisika-uts-01',
  'exam-kimia-uts-xii-2026'
)
AND NOT EXISTS (
  SELECT 1 FROM exam_attempts a WHERE a.exam_id = e.id
);
