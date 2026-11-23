export async function seedDatabase(database) {
  const now = new Date();
  await seedTeacherWorkspace(database, now);
}

async function seedTeacherWorkspace(database, now) {
  const schoolId = "school-sman2-lubuk-linggau";
  await database.query(`
    INSERT INTO schools (id, name, created_at) VALUES ($1, $2, $3)
    ON CONFLICT (id) DO NOTHING
  `, [schoolId, "SMAN 2 Kota Lubuk Linggau", now]);
  const subjectId = "subject-kimia-sman2-lubuk-linggau";
  await database.query(`
    INSERT INTO subjects (id, school_id, name, created_at) VALUES ($1, $2, 'Kimia', $3)
    ON CONFLICT (id) DO NOTHING
  `, [subjectId, schoolId, now]);
  await database.query(`
    INSERT INTO teachers (id, user_id, full_name, school_id, subject_id, subject, created_at)
    VALUES ('teacher-emma-murniati', NULL, 'Emma Murniati, S.Pd.', $1, $2, 'Kimia', $3)
    ON CONFLICT (id) DO NOTHING
  `, [schoolId, subjectId, now]);

  await database.query(
    "UPDATE classes SET program = '' WHERE school_id = $1",
    [schoolId],
  );
  await database.query(`
    DELETE FROM classes
    WHERE school_id = $1
      AND NOT (
        name ~ '^X [0-9]+$'
        OR name ~ '^XI F [0-9]+$'
        OR name ~ '^XI [0-9]+$'
        OR name ~ '^XII [0-9]+$'
      )
  `, [schoolId]);
  for (const [gradeLevel, count] of [["X", 12], ["XI", 11], ["XII", 11]]) {
    for (let number = 1; number <= count; number++) {
      const id = `class-${gradeLevel.toLowerCase()}-${number}`;
      const name = gradeLevel === "XI"
        ? `XI F ${number}`
        : `${gradeLevel} ${number}`;
      await database.query(`
        INSERT INTO classes (id, school_id, name, grade_level, program)
        VALUES ($1, $2, $3, $4, '')
        ON CONFLICT (school_id, name) DO UPDATE SET
          grade_level = EXCLUDED.grade_level,
          program = ''
      `, [id, schoolId, name, gradeLevel]);
    }
  }

}
