INSERT INTO schools (id, name)
VALUES ('school-sman2-lubuk-linggau', 'SMAN 2 Kota Lubuk Linggau')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE classes
  ALTER COLUMN program SET DEFAULT '';

UPDATE classes SET program = '';

DELETE FROM classes
WHERE school_id = 'school-sman2-lubuk-linggau'
  AND NOT (
    name ~ '^X [0-9]+$'
    OR name ~ '^XI [0-9]+$'
    OR name ~ '^XII [0-9]+$'
  );

INSERT INTO classes (id, school_id, name, grade_level, program)
SELECT
  'class-x-' || number,
  'school-sman2-lubuk-linggau',
  'X ' || number,
  'X',
  ''
FROM (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12)) AS numbers(number)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  grade_level = EXCLUDED.grade_level,
  program = '';

INSERT INTO classes (id, school_id, name, grade_level, program)
SELECT
  'class-' || lower(grade) || '-' || number,
  'school-sman2-lubuk-linggau',
  grade || ' ' || number,
  grade,
  ''
FROM (
  VALUES
    ('XI',1),('XI',2),('XI',3),('XI',4),('XI',5),('XI',6),
    ('XI',7),('XI',8),('XI',9),('XI',10),('XI',11),
    ('XII',1),('XII',2),('XII',3),('XII',4),('XII',5),('XII',6),
    ('XII',7),('XII',8),('XII',9),('XII',10),('XII',11)
) AS grades_numbers(grade, number)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  grade_level = EXCLUDED.grade_level,
  program = '';
