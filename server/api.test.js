import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrateDatabase } from "./database.js";
import { migrateSqliteData } from "./migrate-sqlite.js";
import { seedDatabase } from "./seed.js";

const origin = "http://localhost:5173";

async function startServer(t) {
  const { baseUrl } = await startServerWithApp(t);
  return baseUrl;
}

async function startServerWithApp(t) {
  const pglite = await PGlite.create();
  const postgresServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await postgresServer.start();
  const [host, port] = postgresServer.getServerConn().split(":");
  const database = new pg.Pool({
    host,
    port: Number(port),
    database: "postgres",
    user: "postgres",
    password: "postgres",
    max: 1,
  });
  await migrateDatabase(database);
  await seedDatabase(database);
  const app = createApp({
    authRateLimitMax: 20,
    authRateLimitWindowMs: 60_000,
    cookieSameSite: "Lax",
    database: {},
    frontendOrigins: [origin],
    jwtExpiresInSeconds: 14 * 24 * 60 * 60,
    jwtSecret: "test-secret-with-more-than-thirty-two-bytes",
    secureCookie: false,
    trustProxy: false,
  }, { database });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await app.locals.close();
    await postgresServer.stop();
    await pglite.close();
  });
  return { app, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("HTTP API requires class registration and keeps exam data empty without published exams", async (t) => {
  const baseUrl = await startServer(t);
  const optionsResponse = await fetch(`${baseUrl}/api/public/registration-options`, {
    headers: { origin },
  });
  const options = await optionsResponse.json();
  const missingClass = await postJson(`${baseUrl}/api/auth/register`, {
    fullName: "Siswa Tanpa Kelas",
    email: "no-class@example.test",
    password: "rahasia123",
    schoolId: options.school.id,
  }, { origin });
  assert.equal(missingClass.status, 400);
  const registered = await postJson(`${baseUrl}/api/auth/register`, {
    fullName: "Siswa API",
    email: "api@example.test",
    password: "rahasia123",
    schoolId: options.school.id,
    classId: options.classes[0].id,
  }, { origin });
  assert.equal(registered.status, 201);
  const cookie = registered.headers.get("set-cookie").split(";", 1)[0];
  assert.match(registered.headers.get("set-cookie"), /HttpOnly/);

  const currentUser = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie, origin } });
  const sessionUser = (await currentUser.json()).user;
  assert.equal(sessionUser.email, "api@example.test");
  assert.equal(sessionUser.className, options.classes[0].name);
  const profileResponse = await fetch(`${baseUrl}/api/student/profile`, {
    headers: { cookie, origin },
  });
  assert.equal(profileResponse.status, 200);
  const { profile } = await profileResponse.json();
  assert.equal(profile.fullName, "Siswa API");
  assert.equal(profile.schoolName, options.school.name);
  assert.equal(profile.className, options.classes[0].name);
  assert.ok(profile.createdAt);
  const profileUpdate = await fetch(`${baseUrl}/api/student/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({
      fullName: "Siswa API Updated",
      email: "api-updated@example.test",
      classId: options.classes.at(-1).id,
    }),
  });
  assert.equal(profileUpdate.status, 200);
  assert.equal((await profileUpdate.json()).profile.className, options.classes[0].name);
  const passwordUpdate = await fetch(`${baseUrl}/api/student/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({
      fullName: "Siswa API Updated",
      email: "api-updated@example.test",
      currentPassword: "rahasia123",
      newPassword: "new-password-123",
    }),
  });
  assert.equal(passwordUpdate.status, 200);
  const loginResponse = await postJson(
    `${baseUrl}/api/auth/login`,
    { email: "api-updated@example.test", password: "new-password-123" },
    { origin },
  );
  assert.equal(loginResponse.status, 200);
  const loginCookie = loginResponse.headers.get("set-cookie").split(";", 1)[0];
  const wrongPassword = await postJson(
    `${baseUrl}/api/auth/login`,
    { email: "api@example.test", password: "incorrect" },
    { origin },
  );
  assert.equal(wrongPassword.status, 401);

  const examsResponse = await fetch(`${baseUrl}/api/student/exams`, {
    headers: { cookie, origin },
  });
  assert.equal(examsResponse.status, 200);
  assert.deepEqual((await examsResponse.json()).exams, []);
  const resultsResponse = await fetch(`${baseUrl}/api/student/results`, {
    headers: { cookie, origin },
  });
  assert.deepEqual((await resultsResponse.json()).results, []);

  const logoutResponse = await postJson(
    `${baseUrl}/api/auth/logout`,
    {},
    { cookie: loginCookie, origin },
  );
  assert.equal(logoutResponse.status, 200);
  const protectedResponse = await fetch(`${baseUrl}/api/student/exams`, {
    headers: { cookie: loginCookie, origin },
  });
  assert.equal(protectedResponse.status, 401);
});

test("HTTP API rejects unauthorized origins and unauthenticated exam access", async (t) => {
  const baseUrl = await startServer(t);
  const unauthorized = await fetch(`${baseUrl}/api/student/exams`);
  assert.equal(unauthorized.status, 401);

  const forbiddenOrigin = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { origin: "https://not-allowed.example" },
  });
  assert.equal(forbiddenOrigin.status, 403);
  const health = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await health.json(), { status: "ok", database: "postgres" });
});

test("platform admins can switch schools while school admins stay scoped", async (t) => {
  const { app, baseUrl } = await startServerWithApp(t);
  const database = app.locals.database;
  const schoolId = "school-sman2-lubuk-linggau";
  const otherSchoolId = "school-other";
  await database.query(
    "INSERT INTO schools (id, name) VALUES ($1, $2)",
    [otherSchoolId, "Sekolah Kedua"],
  );
  await database.query(`
    INSERT INTO classes (id, school_id, name, grade_level, program)
    VALUES ('class-other-x1', $1, 'X 1', 'X', '')
  `, [otherSchoolId]);

  const password = "platform-admin-password";
  const salt = "test-admin-salt";
  const passwordHash = scryptSync(password, salt, 64).toString("hex");
  await database.query(`
    INSERT INTO users (
      id, full_name, email, password_salt, password_hash, role, school_id
    ) VALUES
      ('jk-23.11.2026-15.16', 'Admin NSolve', 'platform-admin@example.test', $1, $2, 'admin', NULL),
      ('school-admin', 'Admin Sekolah', 'school-admin@example.test', $1, $2, 'admin', $3)
  `, [salt, passwordHash, schoolId]);

  async function login(email) {
    const response = await postJson(`${baseUrl}/api/auth/login`, { email, password }, { origin });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";", 1)[0];
  }

  const platformCookie = await login("platform-admin@example.test");
  const platformUser = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: platformCookie, origin },
  });
  assert.equal((await platformUser.json()).user.id, "jk-23.11.2026-15.16");

  const schoolsResponse = await fetch(`${baseUrl}/api/admin/schools`, {
    headers: { cookie: platformCookie, origin },
  });
  const { schools } = await schoolsResponse.json();
  assert.equal(schoolsResponse.status, 200);
  assert.deepEqual(
    schools.map((school) => school.id).sort(),
    [otherSchoolId, schoolId].sort(),
  );

  const missingScope = await fetch(`${baseUrl}/api/admin/classes`, {
    headers: { cookie: platformCookie, origin },
  });
  assert.equal(missingScope.status, 400);
  const otherSchoolClasses = await fetch(
    `${baseUrl}/api/admin/classes?schoolId=${otherSchoolId}`,
    { headers: { cookie: platformCookie, origin } },
  );
  assert.equal(otherSchoolClasses.status, 200);
  assert.deepEqual((await otherSchoolClasses.json()).classes.map((item) => item.name), ["X 1"]);

  const createSchoolResponse = await postJson(`${baseUrl}/api/admin/schools`, {
    id: "smanda-cerdas-02",
    name: "SMAN 2 Cerdas",
    address: "Jalan Pendidikan",
    email: "info@smanda.example.test",
  }, { cookie: platformCookie, origin });
  assert.equal(createSchoolResponse.status, 201);
  const { school: createdSchool } = await createSchoolResponse.json();
  assert.equal(createdSchool.id, "smanda-cerdas-02");
  assert.equal(createdSchool.isActive, true);

  const updateSchoolResponse = await fetch(
    `${baseUrl}/api/admin/schools/${createdSchool.id}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: platformCookie, origin },
      body: JSON.stringify({
        name: "SMAN 2 Cerdas",
        address: "Jalan Pendidikan 2",
        email: "admin@smanda.example.test",
        isActive: true,
      }),
    },
  );
  assert.equal(updateSchoolResponse.status, 200);
  assert.equal((await updateSchoolResponse.json()).school.address, "Jalan Pendidikan 2");

  const schoolClassesResponse = await fetch(
    `${baseUrl}/api/admin/classes?schoolId=${createdSchool.id}`,
    { headers: { cookie: platformCookie, origin } },
  );
  const schoolClasses = (await schoolClassesResponse.json()).classes;
  assert.equal(schoolClasses.length, 34);
  const createdClass = schoolClasses.find((item) => item.name === "XI 9");
  assert.ok(createdClass);

  const createTeacherResponse = await postJson(
    `${baseUrl}/api/admin/users?schoolId=${createdSchool.id}`,
    {
      fullName: "Guru Baru",
      email: "guru@smanda.example.test",
      role: "teacher",
      subject: "Kimia",
      classIds: [createdClass.id],
    },
    { cookie: platformCookie, origin },
  );
  assert.equal(createTeacherResponse.status, 201);
  assert.ok((await createTeacherResponse.json()).temporaryPassword);

  const createStudentResponse = await postJson(
    `${baseUrl}/api/admin/users?schoolId=${createdSchool.id}`,
    {
      fullName: "Siswa Baru",
      email: "siswa@smanda.example.test",
      role: "student",
      classId: createdClass.id,
      password: "student-password-123",
    },
    { cookie: platformCookie, origin },
  );
  assert.equal(createStudentResponse.status, 201);
  assert.equal((await createStudentResponse.json()).temporaryPassword, null);
  const { rows: [storedStudent] } = await database.query(`
    SELECT password_salt, password_hash FROM users WHERE email = $1
  `, ["siswa@smanda.example.test"]);
  assert.notEqual(storedStudent.password_hash, "student-password-123");
  assert.equal(
    storedStudent.password_hash,
    scryptSync("student-password-123", storedStudent.password_salt, 64).toString("hex"),
  );
  const refreshedSchools = await fetch(`${baseUrl}/api/admin/schools`, {
    headers: { cookie: platformCookie, origin },
  });
  const schoolSummary = (await refreshedSchools.json()).schools.find(
    (item) => item.id === createdSchool.id,
  );
  assert.equal(schoolSummary.teacherCount, 1);
  assert.equal(schoolSummary.studentCount, 1);
  assert.equal(schoolSummary.classCount, 34);
  const studentCookie = (await postJson(
    `${baseUrl}/api/auth/login`,
    { email: "siswa@smanda.example.test", password: "student-password-123" },
    { origin },
  )).headers.get("set-cookie").split(";", 1)[0];
  const registrationOptions = await fetch(
    `${baseUrl}/api/public/registration-options?schoolId=${createdSchool.id}`,
    { headers: { origin } },
  );
  const schoolRegistrationOptions = await registrationOptions.json();
  assert.equal(schoolRegistrationOptions.classes.length, 34);
  assert.ok(schoolRegistrationOptions.classes.some((item) => item.name === "XI 9"));

  const deleteSchoolResponse = await fetch(
    `${baseUrl}/api/admin/schools/${createdSchool.id}`,
    { method: "DELETE", headers: { cookie: platformCookie, origin } },
  );
  assert.equal(deleteSchoolResponse.status, 200);
  assert.equal((await deleteSchoolResponse.json()).deleted, true);
  const deletedSchoolData = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM schools WHERE id = $1) AS schools,
      (SELECT COUNT(*) FROM users WHERE school_id = $1) AS users,
      (SELECT COUNT(*) FROM students WHERE school_id = $1) AS students,
      (SELECT COUNT(*) FROM teachers WHERE school_id = $1) AS teachers,
      (SELECT COUNT(*) FROM classes WHERE school_id = $1) AS classes,
      (SELECT COUNT(*) FROM subjects WHERE school_id = $1) AS subjects
  `, [createdSchool.id]);
  assert.deepEqual(Object.values(deletedSchoolData.rows[0]).map(Number), [0, 0, 0, 0, 0, 0]);
  const inactiveLogin = await postJson(`${baseUrl}/api/auth/login`, {
    email: "siswa@smanda.example.test",
    password: "student-password-123",
  }, { origin });
  assert.equal(inactiveLogin.status, 401);
  const inactiveSession = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: studentCookie, origin },
  });
  assert.equal((await inactiveSession.json()).user, null);
  const inactiveRegistrationOptions = await fetch(
    `${baseUrl}/api/public/registration-options?schoolId=${createdSchool.id}`,
    { headers: { origin } },
  );
  assert.equal((await inactiveRegistrationOptions.json()).school, null);

  await postJson(`${baseUrl}/api/admin/schools`, {
    id: "standard-school",
    name: "Sekolah Baru",
  }, { cookie: platformCookie, origin });
  const deleteEmptySchool = await fetch(`${baseUrl}/api/admin/schools/standard-school`, {
    method: "DELETE",
    headers: { cookie: platformCookie, origin },
  });
  const standardClassSchoolDelete = await deleteEmptySchool.json();
  assert.equal(standardClassSchoolDelete.deleted, true);

  const schoolCookie = await login("school-admin@example.test");
  const schoolList = await fetch(`${baseUrl}/api/admin/schools`, {
    headers: { cookie: schoolCookie, origin },
  });
  assert.deepEqual((await schoolList.json()).schools.map((school) => school.id), [schoolId]);
  const schoolCannotCreateSchool = await postJson(`${baseUrl}/api/admin/schools`, {
    id: "forbidden-school",
    name: "Sekolah Tidak Diizinkan",
  }, { cookie: schoolCookie, origin });
  assert.equal(schoolCannotCreateSchool.status, 403);
  const crossSchoolAccess = await fetch(
    `${baseUrl}/api/admin/classes?schoolId=${otherSchoolId}`,
    { headers: { cookie: schoolCookie, origin } },
  );
  assert.equal(crossSchoolAccess.status, 403);
});

test("teacher role manages the chemistry SAS workflow and student access is class-scoped", async (t) => {
  const { app, baseUrl } = await startServerWithApp(t);
  const registrationOptionsResponse = await fetch(
    `${baseUrl}/api/public/registration-options`,
    { headers: { origin } },
  );
  assert.equal(registrationOptionsResponse.status, 200);
  const registrationOptions = await registrationOptionsResponse.json();
  assert.equal(registrationOptions.school.name, "SMAN 2 Kota Lubuk Linggau");
  assert.ok(registrationOptions.classes.length >= 11);
  const { rows: schemaRows } = await app.locals.database.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
  `, [[
    "users", "schools", "teachers", "students", "classes", "subjects", "exams",
    "exam_questions", "exam_options", "exam_attempts", "exam_answers", "exam_results",
    "teacher_classes", "exam_activity_events", "admin_password_reset_logs",
  ]]);
  assert.equal(schemaRows.length, 15);
  const originHeaders = { origin };
  const anonymousAccess = await fetch(`${baseUrl}/api/teacher/dashboard`, { headers: originHeaders });
  assert.equal(anonymousAccess.status, 401);
  const teacherRegistration = await postJson(`${baseUrl}/api/auth/register`, {
    fullName: "Emma Murniati, S.Pd.",
    email: "emma.teacher@example.test",
    password: "teacher-password-123",
    schoolId: registrationOptions.school.id,
    classId: registrationOptions.classes[0].id,
  }, originHeaders);
  const teacherCookie = teacherRegistration.headers.get("set-cookie").split(";", 1)[0];
  const database = app.locals.database;
  const { rows: [teacher] } = await database.query(
    "SELECT id FROM users WHERE email = $1",
    ["emma.teacher@example.test"],
  );
  await database.query(`
    UPDATE users SET role = 'teacher', school_id = $1 WHERE id = $2
  `, ["school-sman2-lubuk-linggau", teacher.id]);
  await database.query(
    "UPDATE teachers SET user_id = $1 WHERE id = 'teacher-emma-murniati'",
    [teacher.id],
  );
  const adminRegistration = await postJson(`${baseUrl}/api/auth/register`, {
    fullName: "Admin Sekolah",
    email: "admin@example.test",
    password: "admin-password-123",
    schoolId: registrationOptions.school.id,
    classId: registrationOptions.classes[0].id,
  }, originHeaders);
  const adminCookie = adminRegistration.headers.get("set-cookie").split(";", 1)[0];
  const { rows: [admin] } = await database.query(
    "SELECT id FROM users WHERE email = $1",
    ["admin@example.test"],
  );
  await database.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.id]);
  const adminAssignmentsBefore = await fetch(`${baseUrl}/api/admin/teacher-assignments`, {
    headers: { cookie: adminCookie, ...originHeaders },
  });
  assert.equal(adminAssignmentsBefore.status, 200);
  const teacherAdminAccess = await fetch(`${baseUrl}/api/admin/teacher-assignments`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  assert.equal(teacherAdminAccess.status, 403);
  const assignmentsBefore = await adminAssignmentsBefore.json();
  assert.deepEqual(assignmentsBefore.teachers[0].classes, []);
  const classIds = registrationOptions.classes
    .filter((item) => ["XI 9", "XI 11"].includes(item.name))
    .map((item) => item.id);
  const assignmentResponse = await fetch(
    `${baseUrl}/api/admin/teachers/teacher-emma-murniati/classes`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: adminCookie, ...originHeaders },
      body: JSON.stringify({ classIds }),
    },
  );
  assert.equal(assignmentResponse.status, 200);
  assert.deepEqual(
    (await assignmentResponse.json()).teachers[0].classes.map((item) => item.name),
    ["XI 11", "XI 9"],
  );

  const dashboardResponse = await fetch(`${baseUrl}/api/teacher/dashboard`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.teacher.fullName, "Emma Murniati, S.Pd.");
  assert.equal(dashboard.stats.totalClasses, 2);
  assert.equal(dashboard.stats.totalQuestions, 6);
  assert.deepEqual(dashboard.recentExams, []);

  const profileBefore = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  assert.equal(profileBefore.status, 200);
  const profileUpdate = await fetch(`${baseUrl}/api/teacher/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: teacherCookie, ...originHeaders },
    body: JSON.stringify({
      fullName: "Nailah Husna, S.Pd.",
      positionTitle: "Guru Kimia",
      subject: "Kimia",
      academicYear: "2026/2027",
    }),
  });
  assert.equal(profileUpdate.status, 200);
  const updatedProfile = await profileUpdate.json();
  assert.equal(updatedProfile.teacher.fullName, "Nailah Husna, S.Pd.");

  const schoolSubjectsResponse = await fetch(`${baseUrl}/api/admin/subjects`, {
    headers: { cookie: adminCookie, ...originHeaders },
  });
  const schoolSubjects = (await schoolSubjectsResponse.json()).subjects;
  if (!schoolSubjects.some((item) => item.name === "Fisika")) {
    const addPhysicsSubject = await postJson(`${baseUrl}/api/admin/subjects`, {
      name: "Fisika",
    }, { cookie: adminCookie, ...originHeaders });
    assert.equal(addPhysicsSubject.status, 201);
  }
  const createdQuestionResponse = await postJson(`${baseUrl}/api/teacher/questions`, {
    academicYear: "2026/2027",
    subject: "Fisika",
    gradeLevel: "XI",
    chapter: "Elektrolisis",
    difficulty: "sulit",
    type: "multiple_choice_complex",
    prompt: "Pilih semua pernyataan yang benar tentang reaksi pada katode.",
    answerKey: "",
    points: 7,
    explanation: "Pada katode berlangsung reaksi reduksi.",
    options: [
      { label: "A", content: "Terjadi reaksi reduksi.", isCorrect: true },
      { label: "B", content: "Elektron diterima oleh spesies kimia.", isCorrect: true },
      { label: "C", content: "Terjadi reaksi oksidasi.", isCorrect: false },
    ],
  }, { cookie: teacherCookie, ...originHeaders });
  assert.equal(createdQuestionResponse.status, 201);
  const { question: createdQuestion } = await createdQuestionResponse.json();
  assert.equal(createdQuestion.type, "multiple_choice_complex");
  assert.equal(createdQuestion.subject, "Fisika");
  assert.equal(createdQuestion.points, 7);

  const updatedQuestionResponse = await fetch(
    `${baseUrl}/api/teacher/questions/${createdQuestion.id}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: teacherCookie, ...originHeaders },
      body: JSON.stringify({ ...createdQuestion, chapter: "Elektrolisis Bab XI" }),
    },
  );
  assert.equal(updatedQuestionResponse.status, 200);
  assert.equal((await updatedQuestionResponse.json()).question.chapter, "Elektrolisis Bab XI");

  const importResponse = await postJson(`${baseUrl}/api/teacher/questions/import`, {
    questions: [{
      academicYear: "2026/2027",
      gradeLevel: "XI",
      chapter: "Bilangan Kuantum",
      difficulty: "sedang",
      type: "multiple_choice",
      prompt: "Bilangan kuantum utama untuk elektron pada kulit keempat adalah ...",
      answerKey: "",
      options: ["A", "B", "C", "D", "E"].map((label) => ({
        label,
        content: `Opsi ${label}`,
        isCorrect: label === "B",
      })),
    }],
  }, { cookie: teacherCookie, ...originHeaders });
  assert.equal(importResponse.status, 201);
  const imported = await importResponse.json();
  assert.equal(imported.questions.length, 1);
  assert.equal(imported.questions[0].options.find((option) => option.isCorrect).label, "B");

  const filteredQuestions = await fetch(
    `${baseUrl}/api/teacher/questions?chapter=${encodeURIComponent("Sel Volta")}`,
    { headers: { cookie: teacherCookie, ...originHeaders } },
  );
  assert.equal((await filteredQuestions.json()).questions.length, 2);
  const paginatedQuestions = await fetch(
    `${baseUrl}/api/teacher/questions?page=2&pageSize=2`,
    { headers: { cookie: teacherCookie, ...originHeaders } },
  );
  const paginated = await paginatedQuestions.json();
  assert.equal(paginated.pagination.page, 2);
  assert.equal(paginated.questions.length, 2);

  const classesResponse = await fetch(`${baseUrl}/api/teacher/classes`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  const classes = (await classesResponse.json()).classes;
  const targetClass = classes.find((item) => item.name === "XI 9");
  const secondTargetClass = classes.find((item) => item.name === "XI 11");
  const unrelatedClass = classes.find((item) => item.name === "X 1");
  assert.ok(targetClass);
  assert.ok(secondTargetClass);
  assert.equal(unrelatedClass, undefined);
  assert.equal(classes.length, 2);
  const teacherSubjectsResponse = await fetch(`${baseUrl}/api/teacher/subjects`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  assert.equal(teacherSubjectsResponse.status, 200);
  const teacherSubjects = (await teacherSubjectsResponse.json()).subjects;
  assert.ok(teacherSubjects.some((item) => item.name === "Kimia"));
  const availableClassesResponse = await fetch(`${baseUrl}/api/teacher/available-classes`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  const availableClasses = (await availableClassesResponse.json()).classes;
  assert.deepEqual(
    availableClasses.map((item) => item.name).sort(),
    ["XI 11", "XI 9"],
  );
  const unassignedClass = registrationOptions.classes.find((item) => item.name === "X 1");
  assert.ok(unassignedClass);
  const unregisteredSubjectExam = await postJson(`${baseUrl}/api/teacher/exams`, {
    title: "Ujian Mata Pelajaran Belum Terdaftar",
    subject: "Mata Pelajaran Khusus Tidak Terdaftar",
    academicYear: "2026/2027",
    semester: "Genap",
    gradeLevel: "XI",
    durationMinutes: 45,
    mcQuestionCount: 1,
    essayQuestionCount: 0,
    questionIds: ["question-kimia-redoks-001"],
    classIds: [targetClass.id],
  }, { cookie: teacherCookie, ...originHeaders });
  assert.equal(unregisteredSubjectExam.status, 400);
  const unassignedClassExam = await postJson(`${baseUrl}/api/teacher/exams`, {
    title: "Ujian Kelas X 1",
    subject: "Kimia",
    academicYear: "2026/2027",
    semester: "Genap",
    gradeLevel: "X",
    durationMinutes: 45,
    mcQuestionCount: 1,
    essayQuestionCount: 0,
    questionIds: ["question-kimia-redoks-001"],
    classIds: [unassignedClass.id],
  }, { cookie: teacherCookie, ...originHeaders });
  assert.equal(unassignedClassExam.status, 400);
  const duplicateClassResponse = await postJson(`${baseUrl}/api/teacher/classes`, {
    name: "XI 9",
    gradeLevel: "XI",
  }, { cookie: teacherCookie, ...originHeaders });
  assert.equal(duplicateClassResponse.status, 404);
  const examResponse = await postJson(`${baseUrl}/api/teacher/exams`, {
    title: "SAS Kimia XI",
    description: "Ujian Sumatif Akhir Semester Kimia untuk Kelas XI.",
    academicYear: "2026/2027",
    semester: "Genap",
    gradeLevel: "XI",
    durationMinutes: 120,
    mcQuestionCount: 1,
    essayQuestionCount: 1,
    randomizeQuestions: true,
    randomizeOptions: true,
    questionIds: ["question-kimia-redoks-001", "question-kimia-essay-001"],
    classIds: [targetClass.id],
  }, { cookie: teacherCookie, ...originHeaders });
  assert.equal(examResponse.status, 201);
  const { exam } = await examResponse.json();
  assert.equal(exam.showScore, true);
  assert.equal(exam.questions.length, 2);
  assert.equal(exam.status, "draft");
  assert.equal(exam.examType, "SAS");
  assert.equal(exam.autoGrade, true);

  const publishResponse = await postJson(
    `${baseUrl}/api/teacher/exams/${exam.id}/publish`,
    {
      status: "scheduled",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    },
    { cookie: teacherCookie, ...originHeaders },
  );
  assert.equal(publishResponse.status, 200);
  const { exam: publishedExam } = await publishResponse.json();
  assert.match(publishedExam.code, /^KIM\d{2}[#@!]$/);
  assert.ok(publishedExam.publishedAt);
  const publishedExamDetail = await fetch(
    `${baseUrl}/api/teacher/exams/${exam.id}`,
    { headers: { cookie: teacherCookie, ...originHeaders } },
  );
  assert.equal((await publishedExamDetail.json()).exam.code, publishedExam.code);
  const publishedExamList = await fetch(`${baseUrl}/api/teacher/exams`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  assert.equal(
    (await publishedExamList.json()).exams.find((item) => item.id === exam.id).code,
    publishedExam.code,
  );
  const teacherTokenUpdate = await fetch(`${baseUrl}/api/teacher/exams/${exam.id}/token`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: teacherCookie, ...originHeaders },
    body: JSON.stringify({ code: "KIM23#" }),
  });
  assert.equal(teacherTokenUpdate.status, 200);
  assert.equal((await teacherTokenUpdate.json()).exam.code, "KIM23#");
  const republishResponse = await postJson(
    `${baseUrl}/api/teacher/exams/${exam.id}/publish`,
    {
      status: "scheduled",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    },
    { cookie: teacherCookie, ...originHeaders },
  );
  assert.equal((await republishResponse.json()).exam.code, "KIM23#");
  const adminExamList = await fetch(`${baseUrl}/api/admin/exams`, {
    headers: { cookie: adminCookie, ...originHeaders },
  });
  assert.equal(
    (await adminExamList.json()).exams.find((item) => item.id === exam.id).code,
    "KIM23#",
  );
  const adminTokenUpdate = await fetch(`${baseUrl}/api/admin/exams/${exam.id}/token`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie, ...originHeaders },
    body: JSON.stringify({ code: "KIM24@" }),
  });
  assert.equal(adminTokenUpdate.status, 200);
  assert.equal((await adminTokenUpdate.json()).exam.code, "KIM24@");
  const examEditData = {
    title: "Ulangan Harian Kimia XI 9 dan XI 11",
    subject: "Kimia",
    description: "Materi reaksi redoks",
    academicYear: "2026/2027",
    semester: "Genap",
    examType: "UH",
    gradeLevel: "XI",
    durationMinutes: 90,
    kkm: 80,
    mcQuestionCount: 1,
    essayQuestionCount: 1,
    randomizeQuestions: true,
    randomizeOptions: false,
    autoGrade: false,
    visibility: "private",
    status: "active",
    opensAt: new Date(Date.now() - 60_000).toISOString(),
    closesAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    classIds: [targetClass.id, secondTargetClass.id],
    code: "KIM23#",
    questions: [
      {
        type: "multiple_choice",
        prompt: "Apa yang terjadi pada elektron saat oksidasi?",
        answerKey: "",
        points: 2,
        options: ["A", "B", "C", "D", "E"].map((label) => ({
          label,
          content: `Pilihan ${label}`,
          isCorrect: label === "A",
        })),
      },
      {
        type: "essay",
        prompt: "Jelaskan perbedaan oksidasi dan reduksi.",
        answerKey: "Oksidasi melepas elektron; reduksi menerima elektron.",
        points: 5,
        options: [],
      },
    ],
  };
  const examEditResponse = await fetch(`${baseUrl}/api/teacher/exams/${exam.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: teacherCookie, ...originHeaders },
    body: JSON.stringify(examEditData),
  });
  assert.equal(examEditResponse.status, 200);
  const { exam: updatedExam } = await examEditResponse.json();
  assert.equal(updatedExam.title, examEditData.title);
  assert.equal(updatedExam.subject, "Kimia");
  assert.equal(updatedExam.durationMinutes, 90);
  assert.equal(updatedExam.kkm, 80);
  assert.equal(updatedExam.code, "KIM23#");
  assert.equal(updatedExam.status, "active");
  assert.deepEqual(updatedExam.classes.map((item) => item.name), ["XI 11", "XI 9"]);
  assert.equal(updatedExam.questions[0].prompt, examEditData.questions[0].prompt);
  assert.equal(updatedExam.questions[1].answerKey, examEditData.questions[1].answerKey);

  const secondExamResponse = await postJson(`${baseUrl}/api/teacher/exams`, {
    title: "Latihan Fisika",
    subject: "Fisika",
    academicYear: "2026/2027",
    semester: "Genap",
    gradeLevel: "XI",
    durationMinutes: 45,
    mcQuestionCount: 1,
    essayQuestionCount: 0,
    questionIds: [createdQuestion.id],
    classIds: [secondTargetClass.id],
    visibility: "public",
    showScore: false,
  }, { cookie: teacherCookie, ...originHeaders });
  assert.equal(secondExamResponse.status, 201);
  const { exam: secondExam } = await secondExamResponse.json();
  assert.equal(secondExam.subject, "Fisika");
  assert.equal(secondExam.questions[0].points, 7);
  assert.equal(secondExam.showScore, false);
  const secondPublishResponse = await postJson(
    `${baseUrl}/api/teacher/exams/${secondExam.id}/publish`,
    {
      status: "scheduled",
      opensAt: new Date(Date.now() + 60_000).toISOString(),
      closesAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      code: "FIS88@",
    },
    { cookie: teacherCookie, ...originHeaders },
  );
  assert.equal(secondPublishResponse.status, 200);
  const { exam: publishedSecondExam } = await secondPublishResponse.json();
  assert.equal(publishedSecondExam.code, "FIS88@");
  const duplicateExamToken = await fetch(
    `${baseUrl}/api/teacher/exams/${secondExam.id}/token`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: teacherCookie, ...originHeaders },
      body: JSON.stringify({ code: "KIM23#" }),
    },
  );
  assert.equal(duplicateExamToken.status, 409);
  const invalidExamToken = await fetch(
    `${baseUrl}/api/teacher/exams/${secondExam.id}/token`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: teacherCookie, ...originHeaders },
      body: JSON.stringify({ code: "FIS8@" }),
    },
  );
  assert.equal(invalidExamToken.status, 400);
  const analyticsResponse = await fetch(
    `${baseUrl}/api/teacher/exams/${exam.id}/analytics`,
    { headers: { cookie: teacherCookie, ...originHeaders } },
  );
  const analytics = await analyticsResponse.json();
  assert.equal(analytics.summary.submissions, 0);
  assert.equal(analytics.questions.length, 2);

  const studentRegistration = await postJson(`${baseUrl}/api/auth/register`, {
    fullName: "Siswa XI 9",
    email: "siswa-xi9@example.test",
    password: "student-password-123",
    schoolId: registrationOptions.school.id,
    classId: targetClass.id,
  }, originHeaders);
  const studentCookie = studentRegistration.headers.get("set-cookie").split(";", 1)[0];
  const { rows: [student] } = await database.query(
    "SELECT id FROM users WHERE email = $1",
    ["siswa-xi9@example.test"],
  );
  assert.ok(student);
  const participantsResponse = await fetch(`${baseUrl}/api/teacher/participants`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  assert.equal((await participantsResponse.json()).participants.length, 1);
  const teacherResultsResponse = await fetch(`${baseUrl}/api/teacher/results`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  const teacherResults = await teacherResultsResponse.json();
  assert.equal(teacherResults.summary.participants, 1);
  assert.equal(teacherResults.summary.submissions, 0);

  const secondStudentRegistration = await postJson(`${baseUrl}/api/auth/register`, {
    fullName: "Siswa XI 11",
    email: "siswa-xi11@example.test",
    password: "student-password-123",
    schoolId: registrationOptions.school.id,
    classId: secondTargetClass.id,
  }, originHeaders);
  const secondStudentCookie = secondStudentRegistration.headers.get("set-cookie").split(";", 1)[0];

  const outsiderRegistration = await postJson(`${baseUrl}/api/auth/register`, {
    fullName: "Siswa X 1",
    email: "siswa-x1@example.test",
    password: "student-password-123",
    schoolId: registrationOptions.school.id,
    classId: registrationOptions.classes.find((item) => item.name === "X 1").id,
  }, originHeaders);
  const outsiderCookie = outsiderRegistration.headers.get("set-cookie").split(";", 1)[0];
  const { rows: [outsider] } = await database.query(
    "SELECT id FROM users WHERE email = $1",
    ["siswa-x1@example.test"],
  );

  await database.query(
    "INSERT INTO schools (id, name) VALUES ('school-other-tenant', 'Sekolah Lain')",
  );
  await database.query(`
    INSERT INTO classes (id, school_id, name, grade_level, program)
    VALUES ('class-other-tenant', 'school-other-tenant', 'XII 1', 'XII', '')
  `);
  const otherAdminRegistration = await postJson(`${baseUrl}/api/auth/register`, {
    fullName: "Admin Sekolah Lain",
    email: "other-admin@example.test",
    password: "admin-password-123",
    schoolId: "school-other-tenant",
    classId: "class-other-tenant",
  }, originHeaders);
  const otherAdminCookie = otherAdminRegistration.headers.get("set-cookie").split(";", 1)[0];
  const { rows: [otherAdmin] } = await database.query(
    "SELECT id FROM users WHERE email = $1",
    ["other-admin@example.test"],
  );
  await database.query("UPDATE users SET role = 'admin' WHERE id = $1", [otherAdmin.id]);
  const otherTenantEvents = await fetch(`${baseUrl}/api/admin/exam-activity`, {
    headers: { cookie: otherAdminCookie, ...originHeaders },
  });
  const otherTenantActivity = await otherTenantEvents.json();
  assert.deepEqual(otherTenantActivity.events, []);
  assert.deepEqual(otherTenantActivity.sessions, []);
  const crossTenantAssignment = await fetch(
    `${baseUrl}/api/admin/teachers/teacher-emma-murniati/classes`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: adminCookie, ...originHeaders },
      body: JSON.stringify({ classIds: ["class-other-tenant"] }),
    },
  );
  assert.equal(crossTenantAssignment.status, 400);
  const deleteQuestionResponse = await fetch(
    `${baseUrl}/api/teacher/questions/${createdQuestion.id}`,
    { method: "DELETE", headers: { cookie: teacherCookie, ...originHeaders } },
  );
  assert.equal(deleteQuestionResponse.status, 200);
  const deletedBankQuestion = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM question_bank WHERE id = $1) AS questions,
      (SELECT COUNT(*) FROM question_bank_options WHERE question_id = $1) AS options,
      (SELECT COUNT(*) FROM exam_questions
        WHERE exam_id = $2 AND prompt = $3 AND bank_question_id IS NULL) AS exam_copies
  `, [createdQuestion.id, secondExam.id, createdQuestion.prompt]);
  assert.deepEqual(Object.values(deletedBankQuestion.rows[0]).map(Number), [0, 0, 1]);

  const studentExamsResponse = await fetch(`${baseUrl}/api/student/exams`, {
    headers: { cookie: studentCookie, ...originHeaders },
  });
  const studentExams = (await studentExamsResponse.json()).exams;
  const assignedExam = studentExams.find((item) => item.id === exam.id);
  assert.equal(assignedExam.status, "active");
  assert.equal(assignedExam.canStart, true);
  assert.equal("code" in assignedExam, false);
  assert.equal(studentExams.some((item) => item.id === secondExam.id), false);

  const secondStudentExamsResponse = await fetch(`${baseUrl}/api/student/exams`, {
    headers: { cookie: secondStudentCookie, ...originHeaders },
  });
  const secondStudentExams = (await secondStudentExamsResponse.json()).exams;
  assert.ok(secondStudentExams.some((item) => item.id === exam.id));
  assert.ok(secondStudentExams.some((item) => item.id === secondExam.id));

  const outsiderExamsResponse = await fetch(`${baseUrl}/api/student/exams`, {
    headers: { cookie: outsiderCookie, ...originHeaders },
  });
  assert.deepEqual((await outsiderExamsResponse.json()).exams, []);
  const forbiddenExamDetail = await fetch(`${baseUrl}/api/student/exams/${exam.id}`, {
    headers: { cookie: outsiderCookie, ...originHeaders },
  });
  assert.equal(forbiddenExamDetail.status, 404);
  const forbiddenExamStart = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/start`,
    { code: updatedExam.code },
    { cookie: outsiderCookie, ...originHeaders },
  );
  assert.equal(forbiddenExamStart.status, 404);

  const wrongToken = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/start`,
    { code: "SALAH1#" },
    { cookie: studentCookie, ...originHeaders },
  );
  assert.equal(wrongToken.status, 403);

  const started = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/start`,
    { code: updatedExam.code },
    { cookie: studentCookie, ...originHeaders },
  );
  assert.equal(started.status, 201);
  const { attempt } = await started.json();
  const activityResponse = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/activity`,
    { attemptId: attempt.id, eventType: "tab_hidden" },
    { cookie: studentCookie, ...originHeaders },
  );
  assert.equal(activityResponse.status, 201);
  assert.equal((await activityResponse.json()).violationCount, 1);
  const activityLogResponse = await fetch(`${baseUrl}/api/admin/exam-activity`, {
    headers: { cookie: adminCookie, ...originHeaders },
  });
  assert.equal(activityLogResponse.status, 200);
  const activityLog = await activityLogResponse.json();
  assert.equal(activityLog.events[0].eventType, "tab_hidden");
  assert.equal(activityLog.events[0].studentName, "Siswa XI 9");
  assert.equal(activityLog.sessions[0].attemptId, attempt.id);
  assert.equal(activityLog.sessions[0].violationCount, 1);
  const secondActivity = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/activity`,
    { attemptId: attempt.id, eventType: "window_blur" },
    { cookie: studentCookie, ...originHeaders },
  );
  const freeze = await secondActivity.json();
  assert.equal(freeze.violationCount, 2);
  assert.ok(Date.parse(freeze.lockedUntil) > Date.now());
  const frozenQuestions = await fetch(
    `${baseUrl}/api/student/exams/${exam.id}/questions?attemptId=${attempt.id}`,
    { headers: { cookie: studentCookie, ...originHeaders } },
  );
  assert.equal(frozenQuestions.status, 423);
  await database.query(
    "UPDATE exam_attempts SET locked_until = NOW() - INTERVAL '1 second' WHERE id = $1",
    [attempt.id],
  );
  const questionsUrl = `${baseUrl}/api/student/exams/${exam.id}/questions?attemptId=${attempt.id}`;
  const firstQuestionSet = await fetch(questionsUrl, {
    headers: { cookie: studentCookie, ...originHeaders },
  });
  const secondQuestionSet = await fetch(questionsUrl, {
    headers: { cookie: studentCookie, ...originHeaders },
  });
  const firstQuestions = (await firstQuestionSet.json()).questions;
  const secondQuestions = (await secondQuestionSet.json()).questions;
  assert.deepEqual(
    firstQuestions.map((question) => question.id),
    secondQuestions.map((question) => question.id),
  );
  assert.equal(firstQuestions.length, 2);
  const visibleOption = firstQuestions.find((question) => question.options.length)?.options[0];
  assert.ok(visibleOption);
  assert.equal("isCorrect" in visibleOption, false);
  const answeredQuestion = firstQuestions.find((question) => question.options.length > 0);
  const saveAnswer = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/save-answer`,
    {
      attemptId: attempt.id,
      questionId: answeredQuestion.id,
      optionId: visibleOption.id,
    },
    { cookie: studentCookie, ...originHeaders },
  );
  assert.equal(saveAnswer.status, 200);
  const submitAttempt = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/submit`,
    { attemptId: attempt.id },
    { cookie: studentCookie, ...originHeaders },
  );
  const { result } = await submitAttempt.json();
  assert.equal(submitAttempt.status, 200);
  assert.equal(result.questions.length, 2);
  assert.equal(result.kkm, 80);
  assert.equal(result.passed, false);
  assert.ok(result.questions.every((question) =>
    ["correct", "wrong", "unanswered"].includes(question.status)));
  assert.deepEqual(result.questions.map((question) => question.number), [1, 2]);

  const remedialRequestResponse = await postJson(
    `${baseUrl}/api/student/results/${result.id}/remedial`,
    {},
    { cookie: studentCookie, ...originHeaders },
  );
  assert.equal(remedialRequestResponse.status, 201);
  const { request: remedialRequest } = await remedialRequestResponse.json();
  assert.equal(remedialRequest.status, "pending");
  const duplicateRemedialRequest = await postJson(
    `${baseUrl}/api/student/results/${result.id}/remedial`,
    {},
    { cookie: studentCookie, ...originHeaders },
  );
  assert.equal((await duplicateRemedialRequest.json()).request.id, remedialRequest.id);
  const teacherRemedialRequests = await fetch(
    `${baseUrl}/api/teacher/remedial-requests`,
    { headers: { cookie: teacherCookie, ...originHeaders } },
  );
  const { requests: teacherRemedials } = await teacherRemedialRequests.json();
  assert.equal(teacherRemedials[0].studentName, "Siswa XI 9");
  assert.equal(teacherRemedials[0].className, "XI 9");
  assert.equal(teacherRemedials[0].kkm, 80);
  assert.equal(teacherRemedials[0].examId, exam.id);

  const approveRemedial = await fetch(
    `${baseUrl}/api/teacher/remedial-requests/${remedialRequest.id}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: teacherCookie, ...originHeaders },
      body: JSON.stringify({ status: "approved" }),
    },
  );
  assert.equal(approveRemedial.status, 200);
  const remedialExamResponse = await postJson(`${baseUrl}/api/teacher/exams`, {
    title: "Remedial Kimia XI 9",
    subject: "Kimia",
    academicYear: "2026/2027",
    semester: "Genap",
    gradeLevel: "XI",
    durationMinutes: 60,
    kkm: 75,
    mcQuestionCount: 1,
    essayQuestionCount: 0,
    questionIds: ["question-kimia-redoks-001"],
    classIds: [targetClass.id],
    randomizeQuestions: false,
  }, { cookie: teacherCookie, ...originHeaders });
  assert.equal(remedialExamResponse.status, 201);
  const { exam: remedialExam } = await remedialExamResponse.json();
  const remedialExamPublish = await postJson(
    `${baseUrl}/api/teacher/exams/${remedialExam.id}/publish`,
    {
      status: "scheduled",
      opensAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      closesAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    },
    { cookie: teacherCookie, ...originHeaders },
  );
  assert.equal(remedialExamPublish.status, 200);
  const scheduleRemedial = await postJson(
    `${baseUrl}/api/teacher/remedial-requests/${remedialRequest.id}/schedule`,
    { examId: remedialExam.id },
    { cookie: teacherCookie, ...originHeaders },
  );
  assert.equal(scheduleRemedial.status, 200);
  assert.equal((await scheduleRemedial.json()).request.status, "scheduled");
  const examsAfterRemedialSchedule = await fetch(`${baseUrl}/api/student/exams`, {
    headers: { cookie: studentCookie, ...originHeaders },
  });
  const studentExamsAfterRemedial = (await examsAfterRemedialSchedule.json()).exams;
  const assignedRemedialExam = studentExamsAfterRemedial.find((item) => item.id === remedialExam.id);
  assert.ok(assignedRemedialExam);
  assert.equal(assignedRemedialExam.canStart, false);

  const editAfterStart = await fetch(`${baseUrl}/api/teacher/exams/${exam.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: teacherCookie, ...originHeaders },
    body: JSON.stringify(examEditData),
  });
  assert.equal(editAfterStart.status, 409);

  const forbiddenStudentAccess = await fetch(`${baseUrl}/api/teacher/dashboard`, {
    headers: { cookie: studentCookie, ...originHeaders },
  });
  assert.equal(forbiddenStudentAccess.status, 403);
  const crossTenantTokenUpdate = await fetch(
    `${baseUrl}/api/admin/exams/${exam.id}/token`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: otherAdminCookie, ...originHeaders },
      body: JSON.stringify({ code: "KIM25!" }),
    },
  );
  assert.equal(crossTenantTokenUpdate.status, 404);

  const adminStudentsResponse = await fetch(`${baseUrl}/api/admin/users?role=student`, {
    headers: { cookie: adminCookie, ...originHeaders },
  });
  assert.equal(adminStudentsResponse.status, 200);
  const adminStudents = (await adminStudentsResponse.json()).users;
  assert.equal(adminStudents.length, 3);
  const moveStudent = await fetch(`${baseUrl}/api/admin/users/${student.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie, ...originHeaders },
    body: JSON.stringify({ classId: secondTargetClass.id }),
  });
  assert.equal(moveStudent.status, 200);
  assert.equal((await moveStudent.json()).user.className, "XI 11");
  const movedStudentProfile = await fetch(`${baseUrl}/api/student/profile`, {
    headers: { cookie: studentCookie, ...originHeaders },
  });
  assert.equal((await movedStudentProfile.json()).profile.className, "XI 11");
  await fetch(`${baseUrl}/api/admin/users/${student.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie, ...originHeaders },
    body: JSON.stringify({ classId: targetClass.id }),
  });

  const roleChange = await fetch(`${baseUrl}/api/admin/users/${outsider.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie, ...originHeaders },
    body: JSON.stringify({
      role: "teacher",
      subject: "Matematika",
      classIds: [targetClass.id],
    }),
  });
  assert.equal(roleChange.status, 200);
  assert.equal((await roleChange.json()).user.role, "teacher");

  const createSubject = await postJson(`${baseUrl}/api/admin/subjects`, {
    name: "Informatika",
  }, { cookie: adminCookie, ...originHeaders });
  assert.equal(createSubject.status, 201);
  const { subject: adminSubject } = await createSubject.json();
  const refreshedTeacherSubjects = await fetch(`${baseUrl}/api/teacher/subjects`, {
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  assert.ok((await refreshedTeacherSubjects.json()).subjects.some((item) =>
    item.id === adminSubject.id));

  const createTeacherAccount = await postJson(`${baseUrl}/api/admin/users`, {
    fullName: "Guru Baru",
    email: "guru-baru@example.test",
    role: "teacher",
    subject: "Matematika",
    positionTitle: "Guru Matematika",
    classIds: [targetClass.id, secondTargetClass.id],
  }, { cookie: adminCookie, ...originHeaders });
  assert.equal(createTeacherAccount.status, 201);
  const { user: createdTeacher, temporaryPassword: initialPassword } =
    await createTeacherAccount.json();
  assert.equal(createdTeacher.role, "teacher");
  assert.deepEqual(createdTeacher.teacherClasses.map((item) => item.name).sort(), ["XI 11", "XI 9"]);
  const createdTeacherLogin = await postJson(`${baseUrl}/api/auth/login`, {
    email: createdTeacher.email,
    password: initialPassword,
  }, originHeaders);
  assert.equal(createdTeacherLogin.status, 200);
  const resetPasswordResponse = await postJson(
    `${baseUrl}/api/admin/users/${createdTeacher.id}/reset-password`,
    {},
    { cookie: adminCookie, ...originHeaders },
  );
  assert.equal(resetPasswordResponse.status, 200);
  const { temporaryPassword: resetPassword, resetAt } = await resetPasswordResponse.json();
  assert.match(resetPassword, /^NSolve-[A-Za-z0-9_-]{16}!$/);
  assert.ok(resetAt);
  const { rows: [resetAccount] } = await database.query(
    "SELECT password_salt, password_hash FROM users WHERE id = $1",
    [createdTeacher.id],
  );
  assert.notEqual(resetAccount.password_hash, resetPassword);
  const resetHistoryResponse = await fetch(
    `${baseUrl}/api/admin/users/${createdTeacher.id}/password-resets`,
    { headers: { cookie: adminCookie, ...originHeaders } },
  );
  assert.equal(resetHistoryResponse.status, 200);
  const { logs: resetLogs } = await resetHistoryResponse.json();
  assert.equal(resetLogs.length, 1);
  assert.equal(resetLogs[0].actorName, "Admin Sekolah");
  assert.equal(resetLogs[0].targetName, "Guru Baru");
  assert.ok(resetLogs[0].resetAt);
  assert.equal(JSON.stringify(resetLogs).includes(resetPassword), false);
  const oldPasswordLogin = await postJson(`${baseUrl}/api/auth/login`, {
    email: createdTeacher.email,
    password: initialPassword,
  }, originHeaders);
  assert.equal(oldPasswordLogin.status, 401);
  const resetPasswordLogin = await postJson(`${baseUrl}/api/auth/login`, {
    email: createdTeacher.email,
    password: resetPassword,
  }, originHeaders);
  assert.equal(resetPasswordLogin.status, 200);
  const crossTenantUser = await postJson(`${baseUrl}/api/admin/users`, {
    fullName: "Guru Tenant",
    email: "guru-tenant@example.test",
    role: "teacher",
    subject: "Kimia",
    classIds: ["class-other-tenant"],
  }, { cookie: adminCookie, ...originHeaders });
  assert.equal(crossTenantUser.status, 400);
  const createAdminAccount = await postJson(`${baseUrl}/api/admin/users`, {
    fullName: "Admin Baru",
    email: "admin-baru@example.test",
    role: "admin",
  }, { cookie: adminCookie, ...originHeaders });
  assert.equal(createAdminAccount.status, 201);
  assert.equal((await createAdminAccount.json()).user.role, "admin");

  const secondAttemptResponse = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/start`,
    { code: updatedExam.code },
    { cookie: secondStudentCookie, ...originHeaders },
  );
  assert.equal(secondAttemptResponse.status, 201);
  const { attempt: secondAttempt } = await secondAttemptResponse.json();
  for (const eventType of ["tab_hidden", "window_blur", "fullscreen_exit"]) {
    const report = await postJson(
      `${baseUrl}/api/student/exams/${exam.id}/activity`,
      { attemptId: secondAttempt.id, eventType },
      { cookie: secondStudentCookie, ...originHeaders },
    );
    assert.equal(report.status, 201);
  }
  const disqualifiedQuestions = await fetch(
    `${baseUrl}/api/student/exams/${exam.id}/questions?attemptId=${secondAttempt.id}`,
    { headers: { cookie: secondStudentCookie, ...originHeaders } },
  );
  assert.equal(disqualifiedQuestions.status, 403);
  const disqualifiedSave = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/save-answer`,
    {
      attemptId: secondAttempt.id,
      questionId: answeredQuestion.id,
      optionId: visibleOption.id,
    },
    { cookie: secondStudentCookie, ...originHeaders },
  );
  assert.equal(disqualifiedSave.status, 403);
  const disqualifiedSubmit = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/submit`,
    { attemptId: secondAttempt.id },
    { cookie: secondStudentCookie, ...originHeaders },
  );
  assert.equal(disqualifiedSubmit.status, 403);

  const appClosedActivity = await postJson(
    `${baseUrl}/api/student/exams/${exam.id}/activity`,
    { attemptId: secondAttempt.id, eventType: "app_closed" },
    { cookie: secondStudentCookie, ...originHeaders },
  );
  assert.equal(appClosedActivity.status, 201);
  const updatedActivityLog = await fetch(`${baseUrl}/api/admin/exam-activity`, {
    headers: { cookie: adminCookie, ...originHeaders },
  });
  const updatedActivity = await updatedActivityLog.json();
  assert.ok(updatedActivity.events.some((event) => event.eventType === "app_closed"));
  const closedSession = updatedActivity.sessions.find((session) =>
    session.attemptId === secondAttempt.id);
  assert.equal(closedSession.lastEventType, "app_closed");

  await database.query(
    "UPDATE teacher_exam_settings SET show_score = FALSE WHERE exam_id = $1",
    [exam.id],
  );
  const hiddenResultResponse = await fetch(
    `${baseUrl}/api/student/results/${result.id}`,
    { headers: { cookie: studentCookie, ...originHeaders } },
  );
  assert.equal(hiddenResultResponse.status, 200);
  const hiddenResult = (await hiddenResultResponse.json()).result;
  assert.equal(hiddenResult.showScore, false);
  assert.equal(hiddenResult.score, null);
  assert.equal(hiddenResult.correctCount, null);
  assert.deepEqual(hiddenResult.questions, []);
  const hiddenResultsResponse = await fetch(`${baseUrl}/api/student/results`, {
    headers: { cookie: studentCookie, ...originHeaders },
  });
  const hiddenResults = (await hiddenResultsResponse.json()).results;
  assert.equal(hiddenResults.find((item) => item.id === result.id).score, null);
  const hiddenRemedialRequest = await postJson(
    `${baseUrl}/api/student/results/${result.id}/remedial`,
    {},
    { cookie: studentCookie, ...originHeaders },
  );
  assert.equal(hiddenRemedialRequest.status, 403);

  const deleteStudentResponse = await fetch(`${baseUrl}/api/admin/users/${student.id}`, {
    method: "DELETE",
    headers: { cookie: adminCookie, ...originHeaders },
  });
  assert.equal(deleteStudentResponse.status, 200);
  const deletedStudentData = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE id = $1) AS users,
      (SELECT COUNT(*) FROM students WHERE user_id = $1) AS students,
      (SELECT COUNT(*) FROM class_members WHERE student_user_id = $1) AS class_members,
      (SELECT COUNT(*) FROM sessions WHERE user_id = $1) AS sessions,
      (SELECT COUNT(*) FROM exam_attempts WHERE user_id = $1) AS attempts,
      (SELECT COUNT(*) FROM exam_results WHERE user_id = $1) AS results,
      (SELECT COUNT(*) FROM remedial_requests WHERE student_id = $1) AS remedials
  `, [student.id]);
  assert.deepEqual(Object.values(deletedStudentData.rows[0]).map(Number), [0, 0, 0, 0, 0, 0, 0]);

  const { rows: [physicsSubject] } = await database.query(`
    SELECT id FROM subjects
    WHERE school_id = $1 AND name = 'Fisika'
  `, [registrationOptions.school.id]);
  const examBankQuestionId = "teacher-delete-exam-bank-question";
  await database.query(`
    INSERT INTO question_bank (
      id, teacher_id, school_id, subject_id, academic_year, subject, grade_level,
      chapter, difficulty, type, prompt
    ) VALUES (
      $1, 'teacher-emma-murniati', $2, $3, '2026/2027', 'Fisika', 'XI',
      'Elektrolisis', 'sedang', 'multiple_choice', 'Sumber soal ujian yang dihapus?'
    )
  `, [examBankQuestionId, registrationOptions.school.id, physicsSubject.id]);
  await database.query(`
    INSERT INTO question_bank_options (
      id, question_id, position, label, content, is_correct
    ) VALUES ('teacher-delete-exam-bank-option', $1, 1, 'A', 'Pilihan sumber', TRUE)
  `, [examBankQuestionId]);
  await database.query(`
    INSERT INTO exam_questions (
      id, exam_id, position, prompt, type, bank_question_id, points,
      answer_key, school_id
    ) VALUES
      ('teacher-delete-second-exam-question', $1, 2, 'Sumber soal ujian yang dihapus?',
        'multiple_choice', $3, 1, 'A', $2),
      ('teacher-delete-retained-exam-question', $4, 3, 'Salinan di ujian lain tetap ada',
        'multiple_choice', $3, 1, 'A', $2)
  `, [secondExam.id, registrationOptions.school.id, examBankQuestionId, exam.id]);
  await database.query(`
    INSERT INTO exam_options (id, question_id, position, label, content, is_correct)
    VALUES
      ('teacher-delete-second-exam-option', 'teacher-delete-second-exam-question', 1, 'A', 'Pilihan', TRUE),
      ('teacher-delete-retained-exam-option', 'teacher-delete-retained-exam-question', 1, 'A', 'Pilihan', TRUE)
  `);
  const deleteTeacherExamResponse = await fetch(
    `${baseUrl}/api/teacher/exams/${secondExam.id}`,
    { method: "DELETE", headers: { cookie: teacherCookie, ...originHeaders } },
  );
  assert.equal(deleteTeacherExamResponse.status, 200);
  const deletedExamBankData = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM question_bank WHERE id = $1) AS bank_questions,
      (SELECT COUNT(*) FROM question_bank_options WHERE question_id = $1) AS bank_options,
      (SELECT COUNT(*) FROM exam_questions WHERE exam_id = $2) AS deleted_exam_questions,
      (SELECT COUNT(*) FROM exam_questions
        WHERE id = 'teacher-delete-retained-exam-question' AND bank_question_id IS NULL) AS retained_exam_copy
  `, [examBankQuestionId, secondExam.id]);
  assert.deepEqual(Object.values(deletedExamBankData.rows[0]).map(Number), [0, 0, 0, 1]);

  const deleteExamResponse = await fetch(`${baseUrl}/api/teacher/exams/${exam.id}`, {
    method: "DELETE",
    headers: { cookie: teacherCookie, ...originHeaders },
  });
  assert.equal(deleteExamResponse.status, 200);
  const deletedExamData = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM exams WHERE id = $1) AS exams,
      (SELECT COUNT(*) FROM exam_questions WHERE exam_id = $1) AS questions,
      (SELECT COUNT(*) FROM exam_attempts WHERE exam_id = $1) AS attempts,
      (SELECT COUNT(*) FROM exam_results WHERE exam_id = $1) AS results,
      (SELECT COUNT(*) FROM remedial_requests WHERE exam_id = $1 OR scheduled_exam_id = $1) AS remedials
  `, [exam.id]);
  assert.deepEqual(Object.values(deletedExamData.rows[0]).map(Number), [0, 0, 0, 0, 0]);

  await database.query(`
    UPDATE teachers SET subject_id = $1, subject = 'Informatika'
    WHERE id = 'teacher-emma-murniati'
  `, [adminSubject.id]);
  await database.query(`
    UPDATE questions SET subject_id = $1 WHERE school_id = $2
  `, [adminSubject.id, registrationOptions.school.id]);
  await database.query(`
    UPDATE question_bank SET subject_id = $1 WHERE school_id = $2
  `, [adminSubject.id, registrationOptions.school.id]);
  await database.query(`
    UPDATE exams SET subject_id = $1 WHERE id = ANY($2::text[])
  `, [adminSubject.id, [exam.id, remedialExam.id]]);
  const subjectDelete = await fetch(`${baseUrl}/api/admin/subjects/${adminSubject.id}`, {
    method: "DELETE",
    headers: { cookie: adminCookie, ...originHeaders },
  });
  assert.equal(subjectDelete.status, 200);
  const deletedSubjectData = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM subjects WHERE id = $1) AS subjects,
      (SELECT COUNT(*) FROM questions WHERE subject_id = $1) AS questions,
      (SELECT COUNT(*) FROM question_bank WHERE subject_id = $1) AS bank_questions,
      (SELECT COUNT(*) FROM exams WHERE id = ANY($2::text[])) AS exams,
      (SELECT COUNT(*) FROM exam_attempts WHERE exam_id = ANY($2::text[])) AS attempts,
      (SELECT COUNT(*) FROM exam_results WHERE exam_id = ANY($2::text[])) AS results,
      (SELECT COUNT(*) FROM remedial_requests WHERE exam_id = ANY($2::text[])) AS remedials
  `, [adminSubject.id, [exam.id, remedialExam.id]]);
  assert.deepEqual(Object.values(deletedSubjectData.rows[0]).map(Number), [0, 0, 0, 0, 0, 0, 0]);
  const retainedTeacher = await database.query(
    "SELECT subject_id, subject FROM teachers WHERE id = 'teacher-emma-murniati'",
  );
  assert.deepEqual(retainedTeacher.rows[0], { subject_id: null, subject: "Umum" });

  const { rows: [createdTeacherSubject] } = await database.query(`
    SELECT subject_id FROM teachers WHERE id = $1
  `, [createdTeacher.teacherId]);
  const teacherExamId = "admin-delete-teacher-exam";
  await database.query(`
    INSERT INTO exams (
      id, school_id, subject_id, title, subject, teacher_name, code, status,
      duration_minutes, opens_at, closes_at
    ) VALUES (
      $1, $2, $3, 'Ujian Guru Hapus', 'Matematika', 'Guru Baru',
      'DEL25!', 'scheduled', 30, NOW(), NOW() + INTERVAL '1 hour'
    )
  `, [teacherExamId, registrationOptions.school.id, createdTeacherSubject.subject_id]);
  await database.query(`
    INSERT INTO teacher_exam_settings (
      exam_id, teacher_id, school_id, academic_year, semester, grade_level,
      mc_question_count, essay_question_count
    ) VALUES ($1, $2, $3, '2026/2027', 'Ganjil', 'XI', 1, 0)
  `, [teacherExamId, createdTeacher.teacherId, registrationOptions.school.id]);
  const teacherQuestionId = "admin-delete-teacher-question";
  await database.query(`
    INSERT INTO question_bank (
      id, teacher_id, school_id, subject_id, academic_year, subject, grade_level,
      chapter, difficulty, type, prompt
    ) VALUES (
      $1, $2, $3, $4, '2026/2027', 'Matematika', 'XI',
      'Aljabar', 'sedang', 'multiple_choice', 'Soal guru yang akan dihapus?'
    )
  `, [
    teacherQuestionId, createdTeacher.teacherId, registrationOptions.school.id,
    createdTeacherSubject.subject_id,
  ]);
  await database.query(`
    INSERT INTO question_bank_options (
      id, question_id, position, label, content, is_correct
    ) VALUES ('admin-delete-teacher-option', $1, 1, 'A', 'Pilihan', TRUE)
  `, [teacherQuestionId]);
  const deleteTeacherResponse = await fetch(
    `${baseUrl}/api/admin/users/${createdTeacher.id}`,
    { method: "DELETE", headers: { cookie: adminCookie, ...originHeaders } },
  );
  assert.equal(deleteTeacherResponse.status, 200);
  const deletedTeacherData = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE id = $1) AS users,
      (SELECT COUNT(*) FROM teachers WHERE id = $2) AS teachers,
      (SELECT COUNT(*) FROM exams WHERE id = $3) AS exams,
      (SELECT COUNT(*) FROM teacher_exam_settings WHERE exam_id = $3) AS settings,
      (SELECT COUNT(*) FROM question_bank WHERE id = $4) AS bank_questions,
      (SELECT COUNT(*) FROM question_bank_options WHERE question_id = $4) AS options,
      (SELECT COUNT(*) FROM admin_password_reset_logs WHERE target_user_id = $1) AS reset_logs,
      (SELECT COUNT(*) FROM sessions WHERE user_id = $1) AS sessions
  `, [
    createdTeacher.id, createdTeacher.teacherId, teacherExamId, teacherQuestionId,
  ]);
  assert.deepEqual(Object.values(deletedTeacherData.rows[0]).map(Number), [0, 0, 0, 0, 0, 0, 0, 0]);

  const deleteClassResponse = await fetch(
    `${baseUrl}/api/admin/classes/${targetClass.id}`,
    { method: "DELETE", headers: { cookie: adminCookie, ...originHeaders } },
  );
  assert.equal(deleteClassResponse.status, 200);
  const deletedClassData = await database.query(`
    SELECT
      (SELECT COUNT(*) FROM classes WHERE id = $1) AS classes,
      (SELECT COUNT(*) FROM class_members WHERE class_id = $1) AS students,
      (SELECT COUNT(*) FROM teacher_classes WHERE class_id = $1) AS teachers,
      (SELECT COUNT(*) FROM exam_classes WHERE class_id = $1) AS exams
  `, [targetClass.id]);
  assert.deepEqual(Object.values(deletedClassData.rows[0]).map(Number), [0, 0, 0, 0]);
});

test("production configuration requires secure cookies and PostgreSQL", () => {
  const productionEnv = {
    NODE_ENV: "production",
    FRONTEND_ORIGINS: "https://portal.example.com",
    DATABASE_HOST: "db.example.com",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "nsolve",
    DATABASE_USER: "nsolve",
    DATABASE_PASSWORD: "test-password",
    DATABASE_SSL: "true",
    JWT_SECRET: "production-secret-with-at-least-thirty-two-bytes",
    COOKIE_SECURE: "true",
  };
  const config = loadConfig(productionEnv);
  assert.equal(config.seedDemoData, false);
  assert.equal(config.secureCookie, true);
  assert.equal(config.database.host, "db.example.com");
  const developmentConfig = loadConfig({
    ...productionEnv,
    NODE_ENV: "development",
    FRONTEND_ORIGINS: undefined,
    COOKIE_SECURE: undefined,
  });
  assert.ok(developmentConfig.frontendOrigins.includes("http://localhost:5174"));

  assert.throws(
    () => loadConfig({ ...productionEnv, COOKIE_SECURE: "false" }),
    /COOKIE_SECURE must be true/,
  );
  assert.throws(
    () => loadConfig({ ...productionEnv, DATABASE_PASSWORD: "", DATABASE_SSL: "false" }),
    /Set DATABASE_PASSWORD or DATABASE_URL/,
  );
  assert.throws(
    () => loadConfig({ ...productionEnv, DATABASE_URL: "./data/legacy.sqlite" }),
    /PostgreSQL connection string/,
  );
});

test("SQLite migration imports student exam history into PostgreSQL", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nsolve-sqlite-migration-"));
  const sqlitePath = join(directory, "legacy.sqlite");
  const source = new DatabaseSync(sqlitePath);
  source.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, full_name TEXT, email TEXT, password_salt TEXT,
      password_hash TEXT, created_at TEXT
    );
    CREATE TABLE exam (
      id TEXT PRIMARY KEY, title TEXT, subject TEXT, teacher_name TEXT, code TEXT,
      description TEXT, status TEXT, duration_minutes INTEGER, opens_at TEXT,
      closes_at TEXT, created_at TEXT
    );
    CREATE TABLE exam_questions (
      id TEXT PRIMARY KEY, exam_id TEXT, position INTEGER, prompt TEXT, type TEXT
    );
    CREATE TABLE exam_options (
      id TEXT PRIMARY KEY, question_id TEXT, position INTEGER, label TEXT,
      content TEXT, is_correct INTEGER
    );
    CREATE TABLE exam_attempts (
      id TEXT PRIMARY KEY, user_id TEXT, exam_id TEXT, status TEXT, started_at TEXT,
      expires_at TEXT, submitted_at TEXT
    );
    CREATE TABLE exam_answers (
      id TEXT PRIMARY KEY, attempt_id TEXT, question_id TEXT,
      selected_option_id TEXT, answered_at TEXT
    );
    CREATE TABLE exam_results (
      id TEXT PRIMARY KEY, attempt_id TEXT, user_id TEXT, exam_id TEXT,
      score REAL, correct_count INTEGER, wrong_count INTEGER,
      unanswered_count INTEGER, duration_seconds INTEGER, created_at TEXT
    );
  `);
  source.prepare(`
    INSERT INTO users VALUES ('sqlite-student', 'Siswa Lama', 'old@example.test',
      'salt', 'hash', '2026-01-01T00:00:00.000Z')
  `).run();
  source.prepare(`
    INSERT INTO exam VALUES ('sqlite-exam', 'Ujian Lama', 'Kimia', 'Guru',
      'OLD-01', '', 'closed', 60, '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00.000Z', '2025-12-01T00:00:00.000Z')
  `).run();
  source.prepare(`
    INSERT INTO exam_questions VALUES ('sqlite-question', 'sqlite-exam', 1, 'Soal lama', 'multiple_choice')
  `).run();
  source.prepare(`
    INSERT INTO exam_options VALUES ('sqlite-option', 'sqlite-question', 1, 'A', 'Jawaban', 1)
  `).run();
  source.prepare(`
    INSERT INTO exam_attempts VALUES ('sqlite-attempt', 'sqlite-student', 'sqlite-exam',
      'submitted', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z',
      '2026-01-01T00:30:00.000Z')
  `).run();
  source.prepare(`
    INSERT INTO exam_answers VALUES ('sqlite-answer', 'sqlite-attempt', 'sqlite-question',
      'sqlite-option', '2026-01-01T00:05:00.000Z')
  `).run();
  source.prepare(`
    INSERT INTO exam_results VALUES ('sqlite-result', 'sqlite-attempt', 'sqlite-student',
      'sqlite-exam', 100, 1, 0, 0, 1800, '2026-01-01T00:30:00.000Z')
  `).run();
  source.close();

  const pglite = await PGlite.create();
  const postgresServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await postgresServer.start();
  const [host, port] = postgresServer.getServerConn().split(":");
  const database = new pg.Pool({
    host,
    port: Number(port),
    database: "postgres",
    user: "postgres",
    password: "postgres",
    max: 1,
  });
  try {
    await migrateDatabase(database);
    const counts = await migrateSqliteData(sqlitePath, database);
    assert.equal(counts.users, 1);
    assert.equal(counts.results, 1);
    const { rows: [result] } = await database.query(`
      SELECT u.email, r.score, a.selected_option_id
      FROM exam_results r
      JOIN users u ON u.id = r.user_id
      JOIN exam_answers a ON a.attempt_id = r.attempt_id
    `);
    assert.deepEqual(result, {
      email: "old@example.test",
      score: 100,
      selected_option_id: "sqlite-option",
    });
  } finally {
    await database.end();
    await postgresServer.stop();
    await pglite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
