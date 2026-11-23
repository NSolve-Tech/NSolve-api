INSERT INTO classes (id, school_id, name, grade_level, program)
SELECT
  'class-' || md5(s.id) || '-' || lower(levels.grade_level) || '-' || class_numbers.number,
  s.id,
  levels.grade_level || ' ' || class_numbers.number,
  levels.grade_level,
  ''
FROM schools s
CROSS JOIN (VALUES ('X', 12), ('XI', 11), ('XII', 11)) AS levels(grade_level, class_count)
CROSS JOIN LATERAL generate_series(1, levels.class_count) AS class_numbers(number)
ON CONFLICT (school_id, name) DO NOTHING;
