# NSolve Learning API

Base URL: `http://localhost:3001/api`

The API uses an `HttpOnly` JWT cookie named `nsolve_session`. The browser must send credentials (`credentials: "include"`). Protected endpoints return `401` when the cookie is missing, invalid, expired, or revoked.
Newly registered accounts receive the `student` role and must provide `schoolId` and `classId` from the registration options. Teacher endpoints require a teacher account with a configured teacher profile. School-bound admin endpoints stay within the admin's school; the NSolve Platform Admin selects a school for each management request.

## Authentication

### `POST /api/auth/register`

Request:

```json
{
  "fullName": "Nama Siswa",
  "email": "siswa@example.com",
  "password": "minimum-8-chars",
  "schoolId": "school-id",
  "classId": "class-id"
}
```

Returns `201` with `{ "user": { "id", "fullName", "email" } }` and sets the session cookie.

### `GET /api/public/registration-options`

Returns the school and available classes used by the student registration form.

### `POST /api/auth/login`

Request: `{ "email": "siswa@example.com", "password": "..." }`

Returns `200` with the public user and sets the session cookie. Invalid credentials return `401`.

### `GET /api/auth/me`

Returns `{ "user": null }` when signed out, otherwise the public user.

### `POST /api/auth/logout`

Revokes the current JWT session and clears its cookie. Returns `{ "loggedOut": true }`.

### Provision an administrator

Create the global NSolve Platform Admin on the API host with `npm run create-admin`. The interactive command asks for an account ID (default: `jk-23.11.2026-15.16`) and reads the password without echoing it. This account can select and manage any school; school-bound admin accounts remain restricted to their own school. Admin access cannot be granted through public registration.

Platform Admin clients first call `GET /api/admin/schools`, then include the selected `schoolId` query parameter on school-management endpoints.

### Provision a teacher account

Teacher accounts are created by an administrator on the API host, not through public registration:

```sh
npm run create-teacher
```

The command asks for an email and reads the password without echoing it. It provisions the Emma Murniati, S.Pd. profile at SMAN 2 Kota Lubuk Linggau and the school's X 1–12, XI 1–11, and XII 1–11 classes. An administrator assigns the teacher's classes from the admin workspace before the teacher can create exams.

## Exams

All exam endpoints require authentication.

### `GET /api/student/exams`

Returns the student's exam list, including `canStart`, `completed`, `activeAttempt`, opening/closing times, duration, and question count.

### `GET /api/student/exams/:id`

Returns exam details and any in-progress attempt for the current student.

### `POST /api/student/exams/:id/start`

Starts a new attempt or resumes the existing attempt. Token-protected exams require a `code` in the request body. An expired attempt is submitted automatically.

Success response:

```json
{
  "attempt": {
    "id": "attempt-id",
    "status": "in_progress",
    "startedAt": "2026-01-01T10:00:00.000Z",
    "expiresAt": "2026-01-01T12:00:00.000Z"
  },
  "resumed": false
}
```

### `GET /api/student/exams/:id/questions?attemptId=:attemptId`

Returns the attempt's questions, options, and saved selections. Correct-option flags are never exposed before submission.

### `POST /api/student/exams/:id/save-answer`

Request:

```json
{
  "attemptId": "attempt-id",
  "questionId": "question-id",
  "optionId": "option-id"
}
```

Set `optionId` to `null` to clear the answer. Returns `{ "saved": true }`.

### `POST /api/student/exams/:id/submit`

Request: `{ "attemptId": "attempt-id" }`

Grades the attempt once and returns `{ "result": ..., "alreadySubmitted": false }`. Repeated submissions return the existing result.

### `POST /api/student/exams/:id/activity`

Reports best-effort browser activity such as `tab_hidden`, `window_blur`, `fullscreen_exit`, and `print_screen`. During an active attempt, an optional `questionNumber` records the question shown when the event occurred. The second recorded violation freezes the attempt for 30 seconds. The third automatically submits and grades saved answers, then returns `autoSubmitted`, `resultId`, and `showScore`. Events reported before an attempt starts have no question number and do not trigger auto-submission. Browser events cannot guarantee detection of screenshots or all application switching.

## Results and grades

### `GET /api/student/results`

Returns the authenticated student's saved result summaries, including score, KKM, pass/remedial status, correct/wrong/unanswered counts, exam name, and submission time. This powers the frontend's Nilai Saya page.

### `GET /api/student/results/:id`

Returns one result with question text, selected answers, and correct answers for post-submission review.

### `POST /api/student/results/:id/remedial`

Creates a remedial request for a result below its exam's KKM. A student can have one active request per result; a rejected request can be submitted again.

## Teacher workspace

All `/api/teacher/*` routes require a teacher session. Exam targets may include any class in the teacher's own school; class IDs from other schools are rejected.

### `GET /api/teacher/dashboard`

Returns the teacher profile, counts for active exams, assigned students and classes, upcoming and recent exams, and remedial requests for that teacher's exams.

### `GET /api/teacher/classes`

Lists classes assigned to the teacher for the dashboard. Students join a class during registration; teachers do not assign students individually.

### `GET /api/teacher/available-classes`

Lists all classes in the teacher's school, used to select exam target classes.

### `GET /api/teacher/participants`

Lists exam participants automatically derived from the target classes and the students registered in those classes.

### `GET /api/teacher/exams`

Lists the teacher's exam packages with draft, scheduled, active, or completed status.

### `POST /api/teacher/exams`

Creates a draft exam package with questions saved directly to that exam and any class IDs from the teacher's school. Supports academic year, semester, grade, duration, target multiple-choice and essay counts, and question/option randomization. Each item in `questions` includes `type`, `prompt`, `answerKey`, `points`, and an `options` array of `{ "label", "content", "isCorrect" }`.

The exam's KKM is stored with its settings and is used to calculate student pass/remedial status. When question randomization is enabled, each attempt receives a stable order that is reused for review.

### `GET /api/teacher/exams/:id`

Returns an owned exam package, selected questions, options, participant classes, and target question counts. This powers preview and package management.

### `POST /api/teacher/exams/:id/publish`

Publishes a complete package as `scheduled` or `active`. Body:

```json
{
  "status": "scheduled",
  "opensAt": "2026-11-23T01:00:00.000Z",
  "closesAt": "2026-11-23T03:00:00.000Z"
}
```

The API rejects publication until the selected question composition matches the configured counts and at least one class is selected. It generates and persists a subject-prefixed exam token on the first publish; later publishes retain that token. Scheduled exams become available to their assigned students when the opening time is reached.
An optional `code` field may be supplied to set a custom token during publish; otherwise the token is generated automatically.

### `PUT /api/teacher/exams/:id/token`

Changes a published exam's entry token without changing its questions or schedule. Body: `{ "code": "KIM23#" }`. Tokens must contain three uppercase letters, two digits, and one of `#`, `@`, or `!`; duplicate tokens are rejected.

### `GET /api/teacher/exams/:id/analytics`

Returns submission count, average/highest/lowest scores, pass rate, completion percentage, and per-question response/correctness counts based on saved exam results.

### `GET /api/teacher/remedial-requests`

Lists remedial requests for exams owned by the authenticated teacher.

### `PUT /api/teacher/remedial-requests/:id`

Approves or rejects a pending request. Approved requests can be associated with a published remedial exam for the same student, class, subject, and teacher.

### `POST /api/teacher/remedial-requests/:id/schedule`

Associates an approved request with an eligible published remedial exam.

### Admin workspace

- `GET /api/admin/users?role=student|teacher|admin` lists accounts in the admin's school.
- `POST /api/admin/users` creates a teacher or admin account. Teacher accounts require a subject and may be assigned classes. Returns a one-time `temporaryPassword` for secure handoff.
- `PUT /api/admin/users/:id` updates account details, role, class, teacher subject/assignments, and active state.
- `DELETE /api/admin/users/:id` removes an account when it has no dependent history; otherwise deactivate it.
- `POST /api/admin/users/:id/reset-password` generates a cryptographically random one-time temporary password, stores only its salted hash, revokes existing sessions, and writes an actor/timestamp audit record. The response includes the temporary password once and `resetAt`.
- `GET /api/admin/users/:id/password-resets` lists the account's reset audit history without password values.
- `GET /api/admin/teacher-assignments` lists teachers and classes in the admin's school.
- `GET /api/admin/exams` includes each exam's saved token and publish timestamp.
- `PUT /api/admin/exams/:id/token` changes a published exam's entry token using the same format and uniqueness rules as the teacher endpoint.
- `PUT /api/admin/teachers/:teacherId/classes` replaces that teacher's class assignments. Body: `{ "classIds": ["class-id"] }`.
- `GET /api/admin/exam-activity` returns the latest reported student activity events for the admin's school, including question numbers when reported and whether a third violation caused automatic submission.

### `GET /health`

Unauthenticated PostgreSQL health check. Returns `{ "status": "ok", "database": "postgres" }`. `/api/health` remains available for compatibility.

## Errors and status codes

Errors use `{ "error": "..." }`. Common statuses: `400` invalid input, `401` authentication required, `403` origin denied, `404` resource/endpoint not found, `409` exam state conflict, `413` request too large, `429` rate limit exceeded, and `500` unexpected server error.

## Database setup

See [README.md](../README.md) for PostgreSQL development setup, Railway/Supabase configuration, migrations, seed data, and importing an existing SQLite database. Set `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, and `DATABASE_SSL`; alternatively use a PostgreSQL `DATABASE_URL`. Run `npm run migrate` before starting the API.

Production starts without demo questions or exams. Local development seeds the named Emma Murniati, SMAN 2 Kota Lubuk Linggau scenario and its standard classes. For multiple API replicas, use a shared production database and a shared rate-limit store before scaling out. In cross-site deployments, set `COOKIE_SAME_SITE=None` and `COOKIE_SECURE=true`, and serve both applications over HTTPS.
