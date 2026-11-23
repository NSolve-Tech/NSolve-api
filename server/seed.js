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

  const questions = [
    {
      id: "question-kimia-redoks-001",
      chapter: "Reaksi Redoks",
      difficulty: "sedang",
      type: "multiple_choice",
      prompt: "Pada reaksi Zn(s) + Cu²⁺(aq) → Zn²⁺(aq) + Cu(s), zat yang bertindak sebagai reduktor adalah ...",
      answerKey: "",
      explanation: "Zn melepaskan elektron dan mengalami oksidasi sehingga bertindak sebagai reduktor.",
      options: [
        ["A", "Zn(s)", true],
        ["B", "Cu²⁺(aq)", false],
        ["C", "Zn²⁺(aq)", false],
        ["D", "Cu(s)", false],
      ],
    },
    {
      id: "question-kimia-redoks-002",
      chapter: "Bilangan Oksidasi",
      difficulty: "mudah",
      type: "multiple_choice",
      prompt: "Bilangan oksidasi atom S dalam senyawa H₂SO₄ adalah ...",
      answerKey: "",
      explanation: "Jumlah bilangan oksidasi senyawa netral bernilai nol: 2(+1) + x + 4(-2) = 0, sehingga x = +6.",
      options: [
        ["A", "+2", false],
        ["B", "+4", false],
        ["C", "+6", true],
        ["D", "-2", false],
      ],
    },
    {
      id: "question-kimia-elektrokimia-001",
      chapter: "Sel Volta",
      difficulty: "sedang",
      type: "multiple_choice",
      prompt: "Pada sel Zn|Zn²⁺ || Cu²⁺|Cu, elektroda yang berfungsi sebagai anode adalah ...",
      answerKey: "",
      explanation: "Anode merupakan tempat oksidasi; pada sel Volta Zn teroksidasi menjadi Zn²⁺.",
      options: [
        ["A", "Elektroda Zn", true],
        ["B", "Elektroda Cu", false],
        ["C", "Jembatan garam", false],
        ["D", "Kedua elektroda", false],
      ],
    },
    {
      id: "question-kimia-redoks-003",
      chapter: "Reaksi Redoks",
      difficulty: "sulit",
      type: "multiple_choice_complex",
      prompt: "Pilih semua pernyataan yang benar tentang oksidasi.",
      answerKey: "",
      explanation: "Oksidasi ditandai dengan pelepasan elektron dan kenaikan bilangan oksidasi.",
      options: [
        ["A", "Melepaskan elektron", true],
        ["B", "Bilangan oksidasi meningkat", true],
        ["C", "Menerima elektron", false],
        ["D", "Bilangan oksidasi menurun", false],
      ],
    },
    {
      id: "question-kimia-essay-001",
      chapter: "Reaksi Redoks",
      difficulty: "sedang",
      type: "essay",
      prompt: "Jelaskan perbedaan oksidasi dan reduksi berdasarkan perpindahan elektron serta perubahan bilangan oksidasi.",
      answerKey: "Oksidasi adalah pelepasan elektron dan kenaikan bilangan oksidasi; reduksi adalah penerimaan elektron dan penurunan bilangan oksidasi.",
      explanation: "Jawaban dinilai berdasarkan perpindahan elektron dan perubahan bilangan oksidasi.",
      options: [],
    },
    {
      id: "question-kimia-essay-002",
      chapter: "Sel Volta",
      difficulty: "sulit",
      type: "essay",
      prompt: "Uraikan aliran elektron dan fungsi jembatan garam pada sel Volta Zn-Cu.",
      answerKey: "Elektron mengalir dari Zn (anode) ke Cu (katode) melalui rangkaian luar. Jembatan garam menjaga kenetralan muatan dengan perpindahan ion.",
      explanation: "Jawaban menyebut arah aliran elektron, anode-katode, serta fungsi menjaga kenetralan muatan.",
      options: [],
    },
  ];
  const { rows: [existingQuestion] } = await database.query(
    "SELECT 1 FROM question_bank WHERE teacher_id = $1 LIMIT 1",
    ["teacher-emma-murniati"],
  );
  if (!existingQuestion) {
    for (const question of questions) {
      await database.query(`
      INSERT INTO question_bank (
        id, teacher_id, school_id, subject_id, academic_year, subject, grade_level,
        chapter, difficulty, type, prompt, answer_key, explanation, created_at
      ) VALUES ($1, 'teacher-emma-murniati', $2, $3, '2026/2027', 'Kimia', 'XI', $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING
      `, [
        question.id, schoolId, subjectId, question.chapter, question.difficulty,
        question.type, question.prompt, question.answerKey, question.explanation, now,
      ]);
      for (const [index, [label, content, isCorrect]] of question.options.entries()) {
        await database.query(`
          INSERT INTO question_bank_options (id, question_id, position, label, content, is_correct)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `, [
          `${question.id}-option-${index + 1}`, question.id, index + 1,
          label, content, isCorrect,
        ]);
      }
    }
  }
}
