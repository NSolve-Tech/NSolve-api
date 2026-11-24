import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";

const scryptAsync = promisify(scrypt);
const JWT_ISSUER = "nsolve-api";
const JWT_AUDIENCE = "nsolve-student";
const MAX_PASSWORD_LENGTH = 128;
const EXAM_ACTIVITY_TYPES = new Set([
  "tab_hidden",
  "window_blur",
  "fullscreen_exit",
  "print_screen",
  "app_closed",
]);

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function toPublicUser(user) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    schoolId: user.schoolId,
    schoolName: user.schoolName,
    className: user.className,
    createdAt: user.createdAt,
    isActive: user.isActive,
  };
}

async function safePasswordMatches(password, salt, expectedHash) {
  const actualHash = Buffer.from(await scryptAsync(password, salt, 64));
  const expected = Buffer.from(expectedHash, "hex");
  return actualHash.length === expected.length && timingSafeEqual(actualHash, expected);
}

export function createStudentService(model, {
  jwtSecret,
  tokenTtlSeconds = 14 * 24 * 60 * 60,
  now = () => new Date(),
} = {}) {
  if (typeof jwtSecret !== "string" || Buffer.byteLength(jwtSecret) < 32) {
    throw new Error("JWT secret must contain at least 32 bytes.");
  }

  async function createSession(userId) {
    const createdAt = now().toISOString();
    const expiresAt = new Date(now().getTime() + tokenTtlSeconds * 1000).toISOString();
    const token = jwt.sign(
      { jti: randomUUID() },
      jwtSecret,
      {
        algorithm: "HS256",
        audience: JWT_AUDIENCE,
        expiresIn: tokenTtlSeconds,
        issuer: JWT_ISSUER,
        subject: userId,
      },
    );
    await model.createSession({
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      createdAt,
    });
    return token;
  }

  async function getUserFromToken(token) {
    if (!token) return null;
    try {
      const claims = jwt.verify(token, jwtSecret, {
        algorithms: ["HS256"],
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER,
      });
      if (typeof claims === "string" || typeof claims.sub !== "string") return null;
      return await model.findUserBySession(hashToken(token), now().toISOString());
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        return null;
      }
      throw error;
    }
  }

  async function requireUser(token) {
    if (!token) throw new ApiError(401, "Silakan masuk untuk melanjutkan.");
    const user = await getUserFromToken(token);
    if (!user) throw new ApiError(401, "Sesi masuk tidak valid atau telah berakhir.");
    return user;
  }

  async function requireRole(token, roles) {
    const user = await requireUser(token);
    if (!roles.includes(user.role)) {
      throw new ApiError(403, "Akun tidak memiliki akses ke fitur ini.");
    }
    return user;
  }

  async function requireExam(examId, userId) {
    const exam = await model.getExam(examId, userId);
    if (!exam) throw new ApiError(404, "Ujian tidak ditemukan.");
    const currentTime = now().getTime();
    const opensAt = Date.parse(exam.opensAt);
    const closesAt = Date.parse(exam.closesAt);
    if (["scheduled", "active"].includes(exam.status)) {
      if (currentTime > closesAt) return { ...exam, status: "closed" };
      if (currentTime < opensAt) return { ...exam, status: "scheduled" };
      if (currentTime >= opensAt) return { ...exam, status: "active" };
    }
    return exam;
  }

  function submit(attempt, resultId = randomUUID()) {
    return model.gradeAttempt({
      attempt,
      resultId,
      submittedAt: now().toISOString(),
    });
  }

  return {
    async getRegistrationOptions(schoolId) {
      return model.getRegistrationOptions(schoolId);
    },
    async register({ fullName, email, password, schoolId, classId }) {
      if (typeof fullName !== "string" || fullName.trim().length < 2 ||
          fullName.trim().length > 120) {
        throw new ApiError(400, "Nama harus terdiri dari 2 sampai 120 karakter.");
      }
      if (typeof email !== "string" || email.trim().length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        throw new ApiError(400, "Masukkan alamat email yang valid.");
      }
      if (typeof password !== "string" || password.length < 8 ||
          password.length > MAX_PASSWORD_LENGTH) {
        throw new ApiError(400, "Kata sandi harus terdiri dari 8 sampai 128 karakter.");
      }
      if (typeof schoolId !== "string" || typeof classId !== "string" ||
          !schoolId || !classId) {
        throw new ApiError(400, "Sekolah dan kelas wajib dipilih.");
      }

      const normalizedEmail = email.trim().toLowerCase();
      if (await model.findUserByEmail(normalizedEmail)) {
        throw new ApiError(409, "Email tersebut sudah terdaftar.");
      }
      const passwordSalt = randomBytes(16).toString("hex");
      const passwordHash = Buffer.from(
        await scryptAsync(password, passwordSalt, 64),
      ).toString("hex");
      let user;
      try {
        user = await model.createUser({
          id: randomUUID(),
          fullName: fullName.trim(),
          email: normalizedEmail,
          passwordSalt,
          passwordHash,
          createdAt: now().toISOString(),
          schoolId,
          classId,
        });
      } catch (error) {
        if (error.code === "23505") {
          throw new ApiError(409, "Email tersebut sudah terdaftar.");
        }
        if (error.message === "REGISTRATION_CLASS_INVALID") {
          throw new ApiError(400, "Kelas yang dipilih tidak tersedia di sekolah tersebut.");
        }
        if (error.message === "REGISTRATION_SCHOOL_INACTIVE") {
          throw new ApiError(400, "Sekolah tidak aktif atau pendaftaran sedang ditutup.");
        }
        throw error;
      }
      return { user: toPublicUser(user), token: await createSession(user.id) };
    },
    async login({ email, password }) {
      if (typeof email !== "string" || typeof password !== "string") {
        throw new ApiError(400, "Email dan kata sandi wajib diisi.");
      }
      if (email.trim().length > 254 || password.length > MAX_PASSWORD_LENGTH) {
        throw new ApiError(400, "Email atau kata sandi tidak valid.");
      }
      const user = await model.findUserByEmail(email.trim().toLowerCase());
      if (!user) {
        await scryptAsync(password, randomBytes(16), 64);
        throw new ApiError(401, "Email atau kata sandi tidak cocok.");
      }
      if (user.isActive === false) {
        await scryptAsync(password, randomBytes(16), 64);
        throw new ApiError(403, "Akun dinonaktifkan. Hubungi administrator sekolah.");
      }
      if (!await safePasswordMatches(password, user.passwordSalt, user.passwordHash)) {
        throw new ApiError(401, "Email atau kata sandi tidak cocok.");
      }
      if (user.schoolId && user.schoolIsActive === false) {
        throw new ApiError(403, "Sekolah ini sedang nonaktif. Hubungi Admin NSolve.");
      }
      return { user: toPublicUser(user), token: await createSession(user.id) };
    },
    async currentUser(token) {
      return getUserFromToken(token);
    },
    async getStudentProfile(token) {
      const user = await requireRole(token, ["student"]);
      const profile = await model.getStudentProfile(user.id);
      if (!profile) throw new ApiError(404, "Profil siswa tidak ditemukan.");
      return { profile };
    },
    async updateStudentProfile(token, input) {
      const user = await requireRole(token, ["student"]);
      if (typeof input?.fullName !== "string" ||
          input.fullName.trim().length < 2 || input.fullName.trim().length > 120) {
        throw new ApiError(400, "Nama harus terdiri dari 2 sampai 120 karakter.");
      }
      if (typeof input?.email !== "string" || input.email.trim().length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
        throw new ApiError(400, "Masukkan alamat email yang valid.");
      }
      let passwordSalt;
      let passwordHash;
      if (input.newPassword || input.currentPassword) {
        if (typeof input.currentPassword !== "string" ||
            typeof input.newPassword !== "string" ||
            input.newPassword.length < 8 || input.newPassword.length > MAX_PASSWORD_LENGTH) {
          throw new ApiError(400, "Kata sandi baru harus terdiri dari 8 sampai 128 karakter dan menyertakan kata sandi saat ini.");
        }
        const account = await model.findUserByEmail(user.email);
        if (!account || !await safePasswordMatches(
          input.currentPassword,
          account.passwordSalt,
          account.passwordHash,
        )) {
          throw new ApiError(403, "Kata sandi saat ini tidak sesuai.");
        }
        passwordSalt = randomBytes(16).toString("hex");
        passwordHash = Buffer.from(
          await scryptAsync(input.newPassword, passwordSalt, 64),
        ).toString("hex");
      }
      try {
        const profile = await model.updateStudentProfile(user.id, {
          fullName: input.fullName.trim(),
          email: input.email.trim().toLowerCase(),
          passwordSalt,
          passwordHash,
        });
        if (!profile) throw new ApiError(404, "Profil siswa tidak ditemukan.");
        return { profile };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Email tersebut sudah digunakan.");
        throw error;
      }
    },
    requireRole,
    async logout(token) {
      if (token) await model.deleteSession(hashToken(token));
    },
    async listExams(token) {
      const user = await requireRole(token, ["student"]);
      const exams = await model.listExams(user.id);
      const evaluatedExams = await Promise.all(exams.map(async (exam) => {
        const completed = await model.hasResult(exam.id, user.id);
        const effectiveExam = await requireExam(exam.id, user.id);
        const { code, ...visibleExam } = effectiveExam;
        return {
          ...visibleExam,
          completed,
          canStart: effectiveExam.status === "active" && !completed,
        };
      }));
      return { exams: evaluatedExams };
    },
    async getExam(token, examId) {
      const user = await requireRole(token, ["student"]);
      const exam = await requireExam(examId, user.id);
      const { code, ...visibleExam } = exam;
      return { exam: visibleExam };
    },
    async getQuestions(token, examId, attemptId) {
      const user = await requireRole(token, ["student"]);
      if (typeof attemptId !== "string" || !attemptId) {
        throw new ApiError(400, "ID percobaan ujian wajib disertakan.");
      }
      const attempt = await model.getAttempt(attemptId, examId, user.id);
      if (!attempt || attempt.status !== "in_progress") {
        throw new ApiError(404, "Percobaan ujian aktif tidak ditemukan.");
      }
      if (attempt.disqualifiedAt) {
        throw new ApiError(403, "Percobaan ujian ditandai untuk verifikasi pengawas.");
      }
      if (attempt.lockedUntil && Date.parse(attempt.lockedUntil) > now().getTime()) {
        throw new ApiError(423, "Sesi ujian dibekukan sementara karena aktivitas terdeteksi.");
      }
      const questions = await model.getQuestionRows(examId, attemptId, user.id);
      if (!questions) throw new ApiError(404, "Percobaan ujian aktif tidak ditemukan.");
      return { questions };
    },
    async recordExamActivity(token, examId, input) {
      const user = await requireRole(token, ["student"]);
      if (!input || !EXAM_ACTIVITY_TYPES.has(input.eventType)) {
        throw new ApiError(400, "Jenis aktivitas ujian tidak valid.");
      }
      if (input.attemptId !== undefined &&
          (typeof input.attemptId !== "string" || !input.attemptId)) {
        throw new ApiError(400, "ID percobaan ujian tidak valid.");
      }
      if (input.questionNumber !== undefined &&
          (!input.attemptId || !Number.isInteger(input.questionNumber) ||
            input.questionNumber < 1)) {
        throw new ApiError(400, "Nomor soal tidak valid.");
      }
      try {
        const activity = await model.recordExamActivity({
          examId,
          attemptId: input.attemptId,
          questionNumber: input.questionNumber,
          userId: user.id,
          eventType: input.eventType,
          occurredAt: now().toISOString(),
        });
        if (!activity) throw new ApiError(404, "Ujian tidak tersedia untuk kelas Anda.");
        if (activity.disqualified && input.attemptId) {
          const attempt = await model.getAttempt(input.attemptId, examId, user.id);
          if (!attempt) throw new ApiError(409, "Percobaan ujian tidak lagi tersedia.");
          const result = await submit(attempt);
          return {
            ...activity,
            autoSubmitted: true,
            resultId: result.id,
            showScore: result.showScore !== false,
          };
        }
        return activity;
      } catch (error) {
        if (error.message === "ATTEMPT_INVALID") {
          throw new ApiError(409, "Percobaan ujian tidak lagi aktif.");
        }
        if (error.message === "QUESTION_NUMBER_INVALID") {
          throw new ApiError(400, "Nomor soal tidak sesuai dengan ujian ini.");
        }
        throw error;
      }
    },
    async startExam(token, examId, { code } = {}) {
      const user = await requireRole(token, ["student"]);
      const exam = await requireExam(examId, user.id);
      if (exam.requiresToken && (typeof code !== "string" || code.trim() !== exam.code)) {
        throw new ApiError(403, "Token ujian tidak sesuai.");
      }
      const activeAttempt = await model.findActiveAttempt(examId, user.id);
      if (activeAttempt) {
        if (activeAttempt.disqualifiedAt) {
          throw new ApiError(403, "Percobaan ujian ditandai untuk verifikasi pengawas.");
        }
        if (activeAttempt.lockedUntil && Date.parse(activeAttempt.lockedUntil) > now().getTime()) {
          throw new ApiError(423, "Sesi ujian dibekukan sementara karena aktivitas terdeteksi.");
        }
        if (Date.parse(activeAttempt.expiresAt) <= now().getTime()) {
          const result = await submit(activeAttempt);
          return { attempt: null, result, resumed: false };
        }
        return { attempt: activeAttempt, resumed: true };
      }
      if (exam.status !== "active" || Date.parse(exam.opensAt) > now().getTime() ||
          Date.parse(exam.closesAt) < now().getTime()) {
        throw new ApiError(409, "Ujian belum dibuka atau sudah ditutup.");
      }
      if (await model.hasResult(examId, user.id)) {
        throw new ApiError(409, "Ujian ini sudah pernah dikumpulkan.");
      }
      const startedAt = now();
      const attempt = await model.createAttempt({
        id: randomUUID(),
        userId: user.id,
        examId,
        startedAt: startedAt.toISOString(),
        expiresAt: new Date(startedAt.getTime() + exam.durationMinutes * 60_000).toISOString(),
      });
      return { attempt, resumed: false };
    },
    async saveAnswer(token, examId, { attemptId, questionId, optionId }) {
      const user = await requireRole(token, ["student"]);
      if (![attemptId, questionId].every((value) => typeof value === "string" && value)) {
        throw new ApiError(400, "ID percobaan dan soal wajib diisi.");
      }
      if (optionId !== null && (typeof optionId !== "string" || !optionId)) {
        throw new ApiError(400, "Pilihan jawaban tidak valid.");
      }
      const attempt = await model.getAttempt(attemptId, examId, user.id);
      if (!attempt || attempt.status !== "in_progress") {
        throw new ApiError(409, "Percobaan ujian tidak lagi aktif.");
      }
      if (attempt.disqualifiedAt) {
        throw new ApiError(403, "Percobaan ujian ditandai untuk verifikasi pengawas.");
      }
      if (attempt.lockedUntil && Date.parse(attempt.lockedUntil) > now().getTime()) {
        throw new ApiError(423, "Sesi ujian dibekukan sementara karena aktivitas terdeteksi.");
      }
      if (Date.parse(attempt.expiresAt) <= now().getTime()) {
        const result = await submit(attempt);
        throw new ApiError(409, `Waktu ujian habis. Hasil tersimpan dengan ID ${result.id}.`);
      }
      if (!await model.saveAnswer({
        attemptId,
        examId,
        userId: user.id,
        questionId,
        optionId: optionId ?? null,
        answeredAt: now().toISOString(),
      })) {
        throw new ApiError(400, "Soal atau pilihan jawaban tidak sesuai dengan ujian ini.");
      }
      return { saved: true };
    },
    async submitExam(token, examId, { attemptId }) {
      const user = await requireRole(token, ["student"]);
      if (typeof attemptId !== "string" || !attemptId) {
        throw new ApiError(400, "ID percobaan ujian wajib disertakan.");
      }
      const existing = await model.getExistingResultForAttempt(attemptId, user.id);
      if (existing) {
        if (existing.examId !== examId) throw new ApiError(404, "Hasil ujian tidak ditemukan.");
        return { result: existing, alreadySubmitted: true };
      }
      const attempt = await model.getAttempt(attemptId, examId, user.id);
      if (!attempt) throw new ApiError(404, "Percobaan ujian tidak ditemukan.");
      if (attempt.disqualifiedAt) {
        throw new ApiError(403, "Percobaan ujian ditandai untuk verifikasi pengawas.");
      }
      if (attempt.lockedUntil && Date.parse(attempt.lockedUntil) > now().getTime()) {
        throw new ApiError(423, "Sesi ujian masih dibekukan sementara.");
      }
      return { result: await submit(attempt), alreadySubmitted: false };
    },
    async listResults(token) {
      const user = await requireRole(token, ["student"]);
      return { results: await model.listResults(user.id) };
    },
    async getResult(token, resultId) {
      const user = await requireRole(token, ["student"]);
      const result = await model.getResult(resultId, user.id);
      if (!result) throw new ApiError(404, "Hasil ujian tidak ditemukan.");
      return { result };
    },
    async requestRemedial(token, resultId) {
      const user = await requireRole(token, ["student"]);
      try {
        const request = await model.requestRemedial(
          user.id,
          resultId,
          now().toISOString(),
        );
        if (!request) throw new ApiError(404, "Hasil ujian tidak ditemukan.");
        return { request };
      } catch (error) {
        if (error.message === "REMEDIAL_NOT_NEEDED") {
          throw new ApiError(409, "Nilai Anda sudah memenuhi KKM; remedial tidak diperlukan.");
        }
        if (error.message === "SCORE_NOT_VISIBLE") {
          throw new ApiError(403, "Guru menyembunyikan nilai ujian ini.");
        }
        throw error;
      }
    },
  };
}
