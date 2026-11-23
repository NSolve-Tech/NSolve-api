UPDATE classes c
SET name = 'XI F ' || substring(c.name FROM '^XI ([0-9]{1,2})$')
FROM schools s
WHERE c.school_id = s.id
  AND (
    s.id = 'school-sman2-lubuk-linggau'
    OR s.name = 'SMAN 2 Kota Lubuk Linggau'
  )
  AND c.grade_level = 'XI'
  AND c.name ~ '^XI ([0-9]{1,2})$'
  AND CAST(substring(c.name FROM '[0-9]+$') AS INTEGER) BETWEEN 1 AND 11;
