import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { ApiError } from "./services.js";

const scryptAsync = promisify(scrypt);

function getSchoolId(user) {
  if (typeof user.schoolId !== "string" || !user.schoolId) {
    throw new ApiError(403, "Akun admin belum ditautkan ke sekolah.");
  }
  return user.schoolId;
}

function requirePlatformAdmin(user) {
  if (user.schoolId) throw new ApiError(403, "Hanya Admin NSolve yang dapat mengelola sekolah.");
}

function assertSchoolActive(user) {
  if (user.schoolIsActive === false) {
    throw new ApiError(409, "Sekolah nonaktif. Aktifkan kembali sekolah sebelum mengubah datanya.");
  }
}

function generateTemporaryPassword(role) {
  const prefix = role
    ? ({ student: "Siswa", teacher: "Guru", admin: "Admin" }[role] ?? "User")
    : "NSolve";
  return `${prefix}-${randomBytes(12).toString("base64url")}!`;
}

export function createAdminService(model) {
  return {
    async scopeAdmin(user, requestedSchoolId) {
      if (user.schoolId) {
        if (requestedSchoolId && requestedSchoolId !== user.schoolId) {
          throw new ApiError(403, "Admin sekolah hanya dapat mengakses sekolahnya sendiri.");
        }
        const school = await model.getSchool(user.schoolId);
        if (!school) throw new ApiError(404, "Sekolah tidak ditemukan.");
        return { ...user, schoolName: school.name, schoolIsActive: school.isActive };
      }
      if (typeof requestedSchoolId !== "string" || !requestedSchoolId) {
        throw new ApiError(400, "Pilih sekolah yang akan dikelola.");
      }
      const school = await model.getSchool(requestedSchoolId);
      if (!school) throw new ApiError(404, "Sekolah tidak ditemukan.");
      return {
        ...user,
        schoolId: school.id,
        schoolName: school.name,
        schoolIsActive: school.isActive,
      };
    },
    async listSchools(user) {
      if (user.schoolId) {
        const school = await model.getSchool(user.schoolId);
        return { schools: school ? [school] : [] };
      }
      return { schools: await model.listSchools() };
    },
    async createSchool(user, input) {
      requirePlatformAdmin(user);
      const id = typeof input?.id === "string" ? input.id.trim() : "";
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      const address = typeof input?.address === "string" ? input.address.trim() : "";
      const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) {
        throw new ApiError(400, "Kode sekolah hanya boleh berisi huruf kecil, angka, dan tanda hubung.");
      }
      if (name.length < 2 || name.length > 160 || address.length > 500 ||
          email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        throw new ApiError(400, "Nama, alamat, atau email sekolah tidak valid.");
      }
      try {
        return { school: await model.createSchool({ id, name, address, email }) };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Kode atau nama sekolah tersebut sudah digunakan.");
        throw error;
      }
    },
    async updatePlatformSchool(user, schoolId, input) {
      requirePlatformAdmin(user);
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      const address = typeof input?.address === "string" ? input.address.trim() : "";
      const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
      if (name.length < 2 || name.length > 160 || address.length > 500 ||
          email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
          typeof input?.isActive !== "boolean") {
        throw new ApiError(400, "Data sekolah tidak valid.");
      }
      try {
        const school = await model.updateSchool(schoolId, { name, address, email, isActive: input.isActive });
        if (!school) throw new ApiError(404, "Sekolah tidak ditemukan.");
        return { school };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Nama sekolah tersebut sudah digunakan.");
        throw error;
      }
    },
    async deleteSchool(user, schoolId) {
      requirePlatformAdmin(user);
      const result = await model.deleteSchool(schoolId);
      if (result.notFound) throw new ApiError(404, "Sekolah tidak ditemukan.");
      return { deleted: true };
    },
    async listTeacherAssignments(user) {
      return model.listTeacherAssignments(getSchoolId(user));
    },
    async setTeacherClasses(user, teacherId, input) {
      assertSchoolActive(user);
      if (!Array.isArray(input?.classIds) ||
          input.classIds.length > 100 ||
          input.classIds.some((id) => typeof id !== "string" || !id)) {
        throw new ApiError(400, "Daftar kelas yang diajarkan tidak valid.");
      }
      try {
        return await model.setTeacherClasses(getSchoolId(user), teacherId, input.classIds);
      } catch (error) {
        if (error.message === "TEACHER_NOT_FOUND") {
          throw new ApiError(404, "Guru tidak ditemukan di sekolah ini.");
        }
        if (error.message === "CLASS_INVALID") {
          throw new ApiError(400, "Satu atau beberapa kelas tidak tersedia di sekolah ini.");
        }
        throw error;
      }
    },
    async listExamActivity(user) {
      const schoolId = getSchoolId(user);
      const [events, sessions] = await Promise.all([
        model.listExamActivity(schoolId),
        model.listActiveExamSessions(schoolId),
      ]);
      return { events, sessions };
    },
    async listUsers(user, role) {
      if (role !== undefined && !["student", "teacher", "admin"].includes(role)) {
        throw new ApiError(400, "Filter role tidak valid.");
      }
      return { users: await model.listUsers(getSchoolId(user), role) };
    },
    async createUser(user, input) {
      const schoolId = getSchoolId(user);
      assertSchoolActive(user);
      if (!input || !["student", "teacher", "admin"].includes(input.role)) {
        throw new ApiError(400, "Role akun baru tidak valid.");
      }
      if (typeof input.fullName !== "string" || input.fullName.trim().length < 2 ||
          input.fullName.trim().length > 120 ||
          typeof input.email !== "string" || input.email.trim().length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
        throw new ApiError(400, "Nama atau alamat email tidak valid.");
      }
      if (input.role === "teacher" &&
          (typeof input.subject !== "string" || input.subject.trim().length < 2 ||
            input.subject.trim().length > 100)) {
        throw new ApiError(400, "Mata pelajaran guru wajib dipilih.");
      }
      const classIds = input.classIds ?? [];
      if (!Array.isArray(classIds) || classIds.length > 100 ||
          classIds.some((id) => typeof id !== "string" || !id)) {
        throw new ApiError(400, "Daftar kelas guru tidak valid.");
      }
      if (input.role === "student" &&
          (typeof input.classId !== "string" || !input.classId)) {
        throw new ApiError(400, "Pilih kelas untuk akun siswa.");
      }
      if (input.password !== undefined &&
          (typeof input.password !== "string" || input.password.length < 8 ||
            input.password.length > 128)) {
        throw new ApiError(400, "Kata sandi harus terdiri dari 8 sampai 128 karakter.");
      }
      const temporaryPassword = input.password ? null : generateTemporaryPassword(input.role);
      const password = input.password || temporaryPassword;
      const passwordSalt = randomBytes(16).toString("hex");
      const passwordHash = Buffer.from(
        await scryptAsync(password, passwordSalt, 64),
      ).toString("hex");
      try {
        const account = await model.createUser(schoolId, {
          fullName: input.fullName.trim(),
          email: input.email.trim().toLowerCase(),
          role: input.role,
          classId: input.role === "student" ? input.classId : null,
          subject: input.role === "teacher" ? input.subject.trim() : null,
          positionTitle: typeof input.positionTitle === "string" &&
            input.positionTitle.trim()
            ? input.positionTitle.trim().slice(0, 120)
            : "Guru",
          classIds: input.role === "teacher" ? classIds : [],
          passwordSalt,
          passwordHash,
        });
        return { user: account, temporaryPassword };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Email tersebut sudah digunakan.");
        if (error.message === "CLASS_INVALID") {
          throw new ApiError(400, "Kelas yang dipilih tidak tersedia di sekolah ini.");
        }
        if (error.message === "SCHOOL_NOT_FOUND") {
          throw new ApiError(404, "Sekolah tidak ditemukan.");
        }
        if (error.message === "SCHOOL_NOT_AVAILABLE") {
          throw new ApiError(409, "Sekolah tidak aktif atau tidak tersedia.");
        }
        throw error;
      }
    },
    async resetPassword(user, userId) {
      const schoolId = getSchoolId(user);
      assertSchoolActive(user);
      if (user.id === userId) {
        throw new ApiError(409, "Gunakan halaman Profil untuk mengubah kata sandi sendiri.");
      }
      const temporaryPassword = generateTemporaryPassword();
      const passwordSalt = randomBytes(16).toString("hex");
      const passwordHash = Buffer.from(
        await scryptAsync(temporaryPassword, passwordSalt, 64),
      ).toString("hex");
      const reset = await model.resetUserPassword(schoolId, userId, {
        passwordSalt,
        passwordHash,
        actorId: user.id,
        actorName: user.fullName,
      });
      if (!reset) {
        throw new ApiError(404, "Pengguna tidak ditemukan di sekolah ini.");
      }
      return { temporaryPassword, resetAt: reset.resetAt };
    },
    async listPasswordResetLogs(user, userId) {
      if (typeof userId !== "string" || !userId) {
        throw new ApiError(400, "ID pengguna tidak valid.");
      }
      return { logs: await model.listPasswordResetLogs(getSchoolId(user), userId) };
    },
    async updateUser(user, userId, input) {
      const schoolId = getSchoolId(user);
      assertSchoolActive(user);
      if (!input || (input.role !== undefined &&
          !["student", "teacher", "admin"].includes(input.role)) ||
          (input.isActive !== undefined && typeof input.isActive !== "boolean")) {
        throw new ApiError(400, "Perubahan akun tidak valid.");
      }
      if (user.id === userId && input.role && input.role !== "admin") {
        throw new ApiError(409, "Admin tidak dapat mengubah role akun sendiri.");
      }
      const fullName = input.fullName;
      const email = input.email;
      if (fullName !== undefined && (typeof fullName !== "string" ||
          fullName.trim().length < 2 || fullName.trim().length > 120)) {
        throw new ApiError(400, "Nama harus terdiri dari 2 sampai 120 karakter.");
      }
      if (email !== undefined && (typeof email !== "string" || email.trim().length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) {
        throw new ApiError(400, "Alamat email tidak valid.");
      }
      if (input.classId !== undefined &&
          (typeof input.classId !== "string" || !input.classId)) {
        throw new ApiError(400, "Kelas siswa tidak valid.");
      }
      if (input.classIds !== undefined &&
          (!Array.isArray(input.classIds) ||
            input.classIds.some((id) => typeof id !== "string" || !id))) {
        throw new ApiError(400, "Daftar kelas guru tidak valid.");
      }
      if (input.subject !== undefined &&
          (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 100)) {
        throw new ApiError(400, "Mata pelajaran guru tidak valid.");
      }
      try {
        await model.updateUser(schoolId, userId, {
          ...input,
          ...(fullName !== undefined ? { fullName: fullName.trim() } : {}),
          ...(email !== undefined ? { email: email.trim().toLowerCase() } : {}),
        });
        return { user: (await model.listUsers(schoolId)).find((item) => item.id === userId) ?? null };
      } catch (error) {
        const messages = {
          USER_NOT_FOUND: [404, "Pengguna tidak ditemukan di sekolah ini."],
          CLASS_INVALID: [400, "Kelas tidak tersedia di sekolah ini."],
          CLASS_REQUIRED: [400, "Pilih kelas saat mengubah role menjadi siswa."],
        };
        if (messages[error.message]) {
          const [status, message] = messages[error.message];
          throw new ApiError(status, message);
        }
        if (error.code === "23505") throw new ApiError(409, "Email tersebut sudah digunakan.");
        throw error;
      }
    },
    async deleteUser(user, userId) {
      assertSchoolActive(user);
      if (user.id === userId) throw new ApiError(409, "Admin tidak dapat menghapus akunnya sendiri.");
      try {
        if (!await model.deleteUser(getSchoolId(user), userId)) {
          throw new ApiError(404, "Pengguna tidak ditemukan di sekolah ini.");
        }
        return { deleted: true };
      } catch (error) {
        if (error.code === "23503") {
          throw new ApiError(409, "Akun tidak dapat dihapus karena masih memiliki data terkait yang belum dapat dibersihkan.");
        }
        throw error;
      }
    },
    async listExams(user) {
      return { exams: await model.listExams(getSchoolId(user)) };
    },
    async updateExamToken(user, examId, input) {
      const code = typeof input?.code === "string" ? input.code.trim().toUpperCase() : "";
      if (!/^[A-Z]{3}\d{2}[#@!]$/.test(code)) {
        throw new ApiError(400, "Token harus berformat tiga huruf, dua angka, dan satu simbol.");
      }
      try {
        const exam = await model.updateExamToken(getSchoolId(user), examId, code);
        if (!exam) throw new ApiError(404, "Ujian tidak ditemukan atau belum dipublish.");
        return { exam };
      } catch (error) {
        if (error.message === "EXAM_TOKEN_TAKEN" || error.code === "23505") {
          throw new ApiError(409, "Token tersebut sudah digunakan ujian lain.");
        }
        throw error;
      }
    },
    async listClasses(user) {
      return { classes: await model.listClasses(getSchoolId(user)) };
    },
    async saveClass(user, classId, input) {
      assertSchoolActive(user);
      if (typeof input?.name !== "string" || input.name.trim().length < 3 ||
          input.name.trim().length > 30 || !["X", "XI", "XII"].includes(input.gradeLevel)) {
        throw new ApiError(400, "Nama kelas dan jenjang tidak valid.");
      }
      const match = input.name.trim().match(/^(X|XI|XII) ([0-9]{1,2})$/);
      const max = input.gradeLevel === "X" ? 12 : 11;
      if (!match || match[1] !== input.gradeLevel ||
          Number(match[2]) < 1 || Number(match[2]) > max) {
        throw new ApiError(400, "Format kelas harus X 1–12, XI 1–11, atau XII 1–11.");
      }
      try {
        return { class: await model.saveClass(
          getSchoolId(user), classId, { name: input.name.trim(), gradeLevel: input.gradeLevel },
        ) };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Nama kelas tersebut sudah digunakan.");
        throw error;
      }
    },
    async deleteClass(user, classId) {
      assertSchoolActive(user);
      if (!await model.deleteClass(getSchoolId(user), classId)) {
        throw new ApiError(404, "Kelas tidak ditemukan.");
      }
      return { deleted: true };
    },
    async listSubjects(user) {
      return { subjects: await model.listSubjects(getSchoolId(user)) };
    },
    async saveSubject(user, subjectId, input) {
      assertSchoolActive(user);
      if (typeof input?.name !== "string" || input.name.trim().length < 2 ||
          input.name.trim().length > 100) {
        throw new ApiError(400, "Nama mata pelajaran tidak valid.");
      }
      try {
        return { subject: await model.saveSubject(getSchoolId(user), subjectId, input.name.trim()) };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Mata pelajaran tersebut sudah tersedia.");
        throw error;
      }
    },
    async deleteSubject(user, subjectId) {
      assertSchoolActive(user);
      try {
        if (!await model.deleteSubject(getSchoolId(user), subjectId)) {
          throw new ApiError(404, "Mata pelajaran tidak ditemukan.");
        }
        return { deleted: true };
      } catch (error) {
        if (error.code === "23503") {
          throw new ApiError(409, "Mata pelajaran tidak dapat dihapus karena masih memiliki data terkait yang belum dapat dibersihkan.");
        }
        throw error;
      }
    },
    async getSchool(user) {
      const school = await model.getSchool(getSchoolId(user));
      if (!school) throw new ApiError(404, "Sekolah tidak ditemukan.");
      return { school };
    },
    async updateSchool(user, input) {
      if (typeof input?.name !== "string" || input.name.trim().length < 2 ||
          input.name.trim().length > 160) {
        throw new ApiError(400, "Nama sekolah tidak valid.");
      }
      try {
        const current = await model.getSchool(getSchoolId(user));
        if (!current) throw new ApiError(404, "Sekolah tidak ditemukan.");
        return { school: await model.updateSchool(getSchoolId(user), {
          name: input.name.trim(),
          address: current.address,
          email: current.email,
          isActive: current.isActive,
        }) };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Nama sekolah tersebut sudah digunakan.");
        throw error;
      }
    },
    async updateProfile(user, input) {
      if (typeof input?.fullName !== "string" || input.fullName.trim().length < 2 ||
          input.fullName.trim().length > 120 ||
          typeof input?.email !== "string" ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
        throw new ApiError(400, "Nama atau alamat email tidak valid.");
      }
      try {
        const profile = await model.updateAdminProfile(user.id, {
          fullName: input.fullName.trim(),
          email: input.email.trim().toLowerCase(),
        });
        if (!profile) throw new ApiError(404, "Profil admin tidak ditemukan.");
        return { profile };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Email tersebut sudah digunakan.");
        throw error;
      }
    },
  };
}
