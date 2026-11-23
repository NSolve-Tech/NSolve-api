import { ApiError } from "./services.js";

const QUESTION_TYPES = new Set([
  "multiple_choice",
  "multiple_choice_complex",
  "true_false",
  "matching",
  "short_answer",
  "essay",
]);
const DIFFICULTIES = new Set(["mudah", "sedang", "sulit"]);

function isText(value, { min = 1, max = 2000 } = {}) {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max;
}

function validateQuestion(input) {
  if (!input || typeof input !== "object") {
    throw new ApiError(400, "Data soal wajib diisi.");
  }
  if (!isText(input.chapter, { max: 120 })) {
    throw new ApiError(400, "Bab wajib diisi maksimal 120 karakter.");
  }
  const subject = input.subject ?? "Kimia";
  if (!isText(subject, { max: 100 })) {
    throw new ApiError(400, "Mata pelajaran tidak valid.");
  }
  if (!isText(input.gradeLevel, { max: 30 })) {
    throw new ApiError(400, "Kelas wajib diisi.");
  }
  if (!DIFFICULTIES.has(input.difficulty)) {
    throw new ApiError(400, "Tingkat kesulitan tidak valid.");
  }
  if (!QUESTION_TYPES.has(input.type)) {
    throw new ApiError(400, "Tipe soal tidak valid.");
  }
  if (!isText(input.prompt, { min: 10, max: 4000 })) {
    throw new ApiError(400, "Isi soal harus terdiri dari 10 sampai 4000 karakter.");
  }
  const academicYear = input.academicYear ?? "2026/2027";
  if (!/^\d{4}\/\d{4}$/.test(academicYear)) {
    throw new ApiError(400, "Tahun ajaran harus menggunakan format YYYY/YYYY.");
  }

  const options = Array.isArray(input.options)
    ? input.options.map((option) => ({
      label: typeof option?.label === "string" ? option.label.trim() : "",
      content: typeof option?.content === "string" ? option.content.trim() : "",
      isCorrect: option?.isCorrect === true,
    }))
    : [];
  const choiceTypes = ["multiple_choice", "multiple_choice_complex", "true_false", "matching"];
  if (choiceTypes.includes(input.type)) {
    if (options.length < 2 || options.length > 10 ||
        options.some((option) => !option.label || !option.content)) {
      throw new ApiError(400, "Soal ini memerlukan 2 sampai 10 opsi yang lengkap.");
    }
    const correctCount = options.filter((option) => option.isCorrect).length;
    if (correctCount === 0 ||
        (input.type === "multiple_choice" && correctCount !== 1) ||
        (input.type === "true_false" && options.length !== 2)) {
      throw new ApiError(400, "Kunci jawaban opsi tidak sesuai dengan tipe soal.");
    }
  }
  if (["short_answer", "essay"].includes(input.type) &&
      !isText(input.answerKey, { max: 2000 })) {
    throw new ApiError(400, "Kunci jawaban wajib diisi untuk tipe soal ini.");
  }
  const points = Number(input.points ?? 1);
  if (!Number.isFinite(points) || points <= 0 || points > 100) {
    throw new ApiError(400, "Bobot nilai harus lebih dari 0 dan maksimal 100.");
  }
  return {
    academicYear,
    subject: subject.trim(),
    gradeLevel: input.gradeLevel.trim(),
    chapter: input.chapter.trim(),
    difficulty: input.difficulty,
    type: input.type,
    prompt: input.prompt.trim(),
    answerKey: typeof input.answerKey === "string" ? input.answerKey.trim() : "",
    explanation: typeof input.explanation === "string" ? input.explanation.trim() : "",
    points,
    options,
  };
}

function validateExam(input) {
  if (!input || typeof input !== "object") {
    throw new ApiError(400, "Data paket ujian wajib diisi.");
  }
  if (!isText(input.title, { max: 120 })) {
    throw new ApiError(400, "Judul ujian wajib diisi maksimal 120 karakter.");
  }
  const durationMinutes = Number(input.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) {
    throw new ApiError(400, "Durasi ujian harus 1 sampai 480 menit.");
  }
  const mcQuestionCount = Number(input.mcQuestionCount);
  const essayQuestionCount = Number(input.essayQuestionCount);
  if (!Number.isInteger(mcQuestionCount) || mcQuestionCount < 0 ||
      !Number.isInteger(essayQuestionCount) || essayQuestionCount < 0 ||
      mcQuestionCount + essayQuestionCount < 1 || mcQuestionCount + essayQuestionCount > 500) {
    throw new ApiError(400, "Jumlah soal ujian tidak valid.");
  }
  if (!Array.isArray(input.classIds) || input.classIds.some((id) => typeof id !== "string")) {
    throw new ApiError(400, "Pilihan kelas tidak valid.");
  }
  const academicYear = input.academicYear ?? "2026/2027";
  if (!/^\d{4}\/\d{4}$/.test(academicYear)) {
    throw new ApiError(400, "Tahun ajaran harus menggunakan format YYYY/YYYY.");
  }
  if (!["Ganjil", "Genap"].includes(input.semester)) {
    throw new ApiError(400, "Semester tidak valid.");
  }
  const examType = input.examType ?? "SAS";
  if (!["SAS", "UTS", "UAS", "UH"].includes(examType)) {
    throw new ApiError(400, "Jenis ujian tidak valid.");
  }
  const visibility = input.visibility ?? "private";
  if (!["private", "public"].includes(visibility)) {
    throw new ApiError(400, "Visibilitas paket ujian tidak valid.");
  }
  const kkm = Number(input.kkm ?? 75);
  if (!Number.isInteger(kkm) || kkm < 0 || kkm > 100) {
    throw new ApiError(400, "KKM harus berupa bilangan bulat antara 0 dan 100.");
  }
  if (input.randomizeQuestions !== undefined && typeof input.randomizeQuestions !== "boolean") {
    throw new ApiError(400, "Pengaturan urutan soal tidak valid.");
  }
  if (input.showScore !== undefined && typeof input.showScore !== "boolean") {
    throw new ApiError(400, "Pengaturan tampilan nilai tidak valid.");
  }
  if (input.opensAt && !Number.isFinite(Date.parse(input.opensAt))) {
    throw new ApiError(400, "Waktu mulai tidak valid.");
  }
  if (input.closesAt && !Number.isFinite(Date.parse(input.closesAt))) {
    throw new ApiError(400, "Waktu selesai tidak valid.");
  }
  const subject = input.subject;
  if (!isText(subject, { max: 100 })) {
    throw new ApiError(400, "Mata pelajaran tidak valid.");
  }
  return {
    title: input.title.trim(),
    subject: subject.trim(),
    description: typeof input.description === "string" ? input.description.trim() : "",
    academicYear,
    examType,
    visibility,
    semester: input.semester,
    gradeLevel: isText(input.gradeLevel, { max: 30 }) ? input.gradeLevel.trim() : "XI",
    durationMinutes,
    mcQuestionCount,
    essayQuestionCount,
    kkm,
    randomizeQuestions: input.randomizeQuestions !== false,
    randomizeOptions: input.randomizeOptions !== false,
    autoGrade: input.autoGrade !== false,
    showScore: input.showScore !== false,
    classIds: input.classIds,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
  };
}

function validateExamQuestions(input, exam) {
  if (!Array.isArray(input?.questions) || input.questions.length < 1 ||
      input.questions.length > 500) {
    throw new ApiError(400, "Daftar soal ujian tidak valid.");
  }
  const questions = input.questions.map((question) => {
    const validated = validateQuestion({
      academicYear: exam.academicYear,
      subject: exam.subject,
      gradeLevel: exam.gradeLevel,
      chapter: exam.title,
      difficulty: "sedang",
      type: question?.type,
      prompt: question?.prompt,
      answerKey: question?.answerKey,
      points: question?.points,
      options: question?.options,
    });
    return {
      type: validated.type,
      prompt: validated.prompt,
      answerKey: validated.answerKey,
      points: validated.points,
      options: validated.options,
    };
  });
  const mcQuestionCount = questions.filter((question) =>
    !["essay", "short_answer"].includes(question.type),
  ).length;
  const essayQuestionCount = questions.length - mcQuestionCount;
  if (exam.mcQuestionCount !== mcQuestionCount ||
      exam.essayQuestionCount !== essayQuestionCount) {
    throw new ApiError(400, "Jumlah soal pilihan ganda dan essay tidak sesuai.");
  }
  return questions;
}

export function createTeacherService(model, { now = () => new Date() } = {}) {
  async function getProfile(user) {
    const profile = await model.findProfileByUserId(user.id);
    if (!profile) throw new ApiError(403, "Profil Guru belum dikonfigurasi.");
    return profile;
  }

  async function requireSchoolSubject(profile, subject) {
    const subjects = await model.listSubjects(profile);
    if (!subjects.some((item) => item.name === subject)) {
      throw new ApiError(400, "Mata pelajaran belum didaftarkan oleh Admin sekolah.");
    }
  }

  return {
    async getProfile(user) {
      return { teacher: await getProfile(user) };
    },
    async listSubjects(user) {
      return { subjects: await model.listSubjects(await getProfile(user)) };
    },
    async updateProfile(user, input) {
      if (!input || typeof input !== "object") {
        throw new ApiError(400, "Data profil wajib diisi.");
      }
      if (!isText(input.fullName, { min: 3, max: 120 })) {
        throw new ApiError(400, "Nama lengkap harus terdiri dari 3 sampai 120 karakter.");
      }
      if (!isText(input.positionTitle, { min: 2, max: 120 })) {
        throw new ApiError(400, "Jabatan guru wajib diisi.");
      }
      if (!isText(input.subject, { min: 2, max: 120 })) {
        throw new ApiError(400, "Mata pelajaran wajib diisi.");
      }
      const academicYear = input.academicYear ?? "2026/2027";
      if (!/^\d{4}\/\d{4}$/.test(academicYear)) {
        throw new ApiError(400, "Tahun ajaran harus menggunakan format YYYY/YYYY.");
      }
      const profile = await getProfile(user);
      const updated = await model.updateProfile(profile, {
        fullName: input.fullName.trim(),
        positionTitle: input.positionTitle.trim(),
        subject: input.subject.trim(),
        academicYear,
      });
      return { teacher: updated };
    },
    async dashboard(user) {
      return model.getDashboard(await getProfile(user));
    },
    async listClasses(user) {
      return { classes: await model.listClasses(await getProfile(user)) };
    },
    async listAvailableClasses(user) {
      return { classes: await model.listAvailableClasses(await getProfile(user)) };
    },
    async createClass(user, input) {
      if (!isText(input?.name, { max: 120 }) ||
          !["X", "XI", "XII"].includes(input?.gradeLevel)) {
        throw new ApiError(400, "Nama kelas dan jenjang wajib diisi.");
      }
      try {
        const item = await model.createClass(await getProfile(user), {
          name: input.name.trim(),
          gradeLevel: input.gradeLevel.trim(),
          program: "",
        });
        return { class: item };
      } catch (error) {
        if (error.code === "23505") throw new ApiError(409, "Nama kelas tersebut sudah ada.");
        throw error;
      }
    },
    async updateClass(user, id, input) {
      if (!isText(input?.name, { max: 120 }) ||
          !["X", "XI", "XII"].includes(input?.gradeLevel)) {
        throw new ApiError(400, "Nama kelas dan jenjang wajib diisi.");
      }
      try {
        const item = await model.updateClass(id, await getProfile(user), {
          name: input.name.trim(),
          gradeLevel: input.gradeLevel.trim(),
          program: "",
        });
        if (!item) throw new ApiError(404, "Kelas tidak ditemukan.");
        return { class: item };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error.code === "23505") throw new ApiError(409, "Nama kelas tersebut sudah ada.");
        throw error;
      }
    },
    async deleteClass(user, id) {
      const deleted = await model.deleteClass(id, await getProfile(user));
      if (!deleted) throw new ApiError(404, "Kelas tidak ditemukan.");
      return { deleted: true };
    },
    async listStudents(user) {
      return { students: await model.listStudents(await getProfile(user)) };
    },
    async assignStudents(user, classId, input) {
      if (!Array.isArray(input?.userIds) ||
          input.userIds.some((id) => typeof id !== "string" || !id)) {
        throw new ApiError(400, "Daftar siswa tidak valid.");
      }
      try {
        const students = await model.assignStudents(
          await getProfile(user),
          classId,
          input.userIds,
          now().toISOString(),
        );
        if (!students) throw new ApiError(404, "Kelas tidak ditemukan.");
        return { students };
      } catch (error) {
        if (error.message === "STUDENT_INVALID") {
          throw new ApiError(400, "Siswa tidak ditemukan atau berasal dari sekolah lain.");
        }
        throw error;
      }
    },
    async listExams(user) {
      return { exams: await model.listExams(await getProfile(user)) };
    },
    async getExam(user, id) {
      const exam = await model.getExam(id, await getProfile(user));
      if (!exam) throw new ApiError(404, "Paket ujian tidak ditemukan.");
      return { exam };
    },
    async updateExam(user, id, input) {
      if (input?.status !== undefined && !["scheduled", "active"].includes(input.status)) {
        throw new ApiError(400, "Status ujian tidak valid.");
      }
      const validated = validateExam({
        ...input,
        classIds: input?.classIds,
      });
      const profile = await getProfile(user);
      await requireSchoolSubject(profile, validated.subject);
      const questions = validateExamQuestions(input, validated);
      if (!input.opensAt || !input.closesAt ||
          Date.parse(input.closesAt) <= Date.parse(input.opensAt)) {
        throw new ApiError(400, "Waktu selesai harus setelah waktu mulai.");
      }
      const code = typeof input.code === "string" && input.code.trim()
        ? input.code.trim().toUpperCase()
        : undefined;
      if (code && !/^[A-Z]{3}\d{2}[#@!]$/.test(code)) {
        throw new ApiError(400, "Token harus berformat tiga huruf, dua angka, dan satu simbol.");
      }
      try {
        const exam = await model.updateExam(id, profile, {
          ...validated,
          status: input.status,
          code,
          questions,
        });
        if (!exam) throw new ApiError(404, "Paket ujian tidak ditemukan.");
        return { exam };
      } catch (error) {
        const messages = {
          CLASS_REQUIRED: "Pilih minimal satu kelas tujuan.",
          CLASS_INVALID: "Kelas yang dipilih tidak tersedia di sekolah Anda.",
          EXAM_ALREADY_ATTEMPTED: "Ujian tidak dapat diubah karena sudah ada siswa yang mulai mengerjakan.",
          EXAM_TOKEN_TAKEN: "Token tersebut sudah digunakan ujian lain.",
        };
        if (messages[error.message]) throw new ApiError(409, messages[error.message]);
        throw error;
      }
    },
    async updateExamToken(user, id, input) {
      const code = typeof input?.code === "string" ? input.code.trim().toUpperCase() : "";
      if (!/^[A-Z]{3}\d{2}[#@!]$/.test(code)) {
        throw new ApiError(400, "Token harus berformat tiga huruf, dua angka, dan satu simbol.");
      }
      try {
        const exam = await model.updateExamToken(id, await getProfile(user), code);
        if (!exam) throw new ApiError(404, "Paket ujian tidak ditemukan.");
        return { exam };
      } catch (error) {
        const messages = {
          EXAM_NOT_PUBLISHED: "Token hanya dapat diubah setelah ujian dipublish.",
          EXAM_TOKEN_TAKEN: "Token tersebut sudah digunakan ujian lain.",
        };
        if (messages[error.message]) throw new ApiError(409, messages[error.message]);
        if (error.code === "23505") throw new ApiError(409, "Token tersebut sudah digunakan ujian lain.");
        throw error;
      }
    },
    async deleteExam(user, id) {
      try {
        const deleted = await model.deleteExam(id, await getProfile(user));
        if (!deleted) throw new ApiError(404, "Paket ujian tidak ditemukan.");
        return { deleted: true };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error.code === "23503") {
          throw new ApiError(
            409,
            "Ujian masih memiliki data terkait yang belum dapat dibersihkan.",
          );
        }
        throw error;
      }
    },
    async createExam(user, input) {
      const profile = await getProfile(user);
      try {
        const validated = validateExam({ ...input, subject: input?.subject ?? profile.subject });
        await requireSchoolSubject(profile, validated.subject);
        const questions = validateExamQuestions(input, validated);
        return {
          exam: await model.createExam(
            profile,
            { ...validated, questions },
            now().toISOString(),
          ),
        };
      } catch (error) {
        if (error.message === "CLASS_INVALID") {
          throw new ApiError(400, "Kelas yang dipilih tidak tersedia di sekolah Anda.");
        }
        throw error;
      }
    },
    async updateExamClasses(user, id, input) {
      if (!Array.isArray(input?.classIds) ||
          input.classIds.some((classId) => typeof classId !== "string" || !classId)) {
        throw new ApiError(400, "Daftar kelas tidak valid.");
      }
      try {
        const exam = await model.updateExamClasses(id, await getProfile(user), input.classIds);
        if (!exam) throw new ApiError(404, "Paket ujian tidak ditemukan.");
        return { exam };
      } catch (error) {
        if (error.message === "CLASS_INVALID") {
          throw new ApiError(400, "Kelas yang dipilih tidak tersedia di sekolah Anda.");
        }
        throw error;
      }
    },
    async publishExam(user, id, input) {
      if (!input || !["scheduled", "active"].includes(input.status) ||
          !Number.isFinite(Date.parse(input.opensAt)) ||
          !Number.isFinite(Date.parse(input.closesAt))) {
        throw new ApiError(400, "Status dan jadwal publikasi harus valid.");
      }
      const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : undefined;
      if (code !== undefined && !/^[A-Z]{3}\d{2}[#@!]$/.test(code)) {
        throw new ApiError(400, "Token harus berformat tiga huruf, dua angka, dan satu simbol.");
      }
      if (!["private", "public"].includes(input.visibility ?? "private")) {
        throw new ApiError(400, "Visibilitas publikasi tidak valid.");
      }
      try {
        const exam = await model.publishExam(
          id,
          await getProfile(user),
          { ...input, code },
          now().toISOString(),
        );
        if (!exam) throw new ApiError(404, "Paket ujian tidak ditemukan.");
        return { exam };
      } catch (error) {
        const messages = {
          QUESTION_COUNTS_MISMATCH: "Jumlah soal terpilih belum sesuai dengan paket: periksa soal pilihan ganda dan essay.",
          CLASS_REQUIRED: "Pilih minimal satu kelas sebelum mempublikasikan ujian.",
          DATE_RANGE_INVALID: "Waktu selesai harus setelah waktu mulai.",
          STATUS_INVALID: "Status publikasi tidak valid.",
          EXAM_TOKEN_UNAVAILABLE: "Token ujian belum dapat dibuat. Silakan coba kembali.",
          EXAM_TOKEN_TAKEN: "Token tersebut sudah digunakan ujian lain.",
        };
        if (messages[error.message]) throw new ApiError(409, messages[error.message]);
        if (error.code === "23505") throw new ApiError(409, "Token tersebut sudah digunakan ujian lain.");
        throw error;
      }
    },
    async analytics(user, id) {
      const report = await model.getAnalytics(id, await getProfile(user));
      if (!report) throw new ApiError(404, "Paket ujian tidak ditemukan.");
      return report;
    },
    async participants(user) {
      return { participants: await model.listParticipants(await getProfile(user)) };
    },
    async results(user) {
      return model.getResults(await getProfile(user));
    },
    async listRemedialRequests(user) {
      return { requests: await model.listRemedialRequests(await getProfile(user)) };
    },
    async updateRemedialRequest(user, requestId, input) {
      if (!input || !["approved", "rejected"].includes(input.status)) {
        throw new ApiError(400, "Keputusan remedial tidak valid.");
      }
      try {
        const request = await model.setRemedialRequestStatus(
          await getProfile(user),
          requestId,
          input.status,
        );
        if (!request) throw new ApiError(404, "Permintaan remedial tidak ditemukan.");
        return { request };
      } catch (error) {
        if (error.message === "REMEDIAL_ALREADY_DECIDED") {
          throw new ApiError(409, "Permintaan remedial sudah diproses.");
        }
        throw error;
      }
    },
    async scheduleRemedialRequest(user, requestId, input) {
      if (typeof input?.examId !== "string" || !input.examId) {
        throw new ApiError(400, "Pilih ujian remedial yang sudah dipublikasikan.");
      }
      try {
        const request = await model.scheduleRemedialRequest(
          await getProfile(user),
          requestId,
          input.examId,
        );
        if (!request) throw new ApiError(404, "Permintaan remedial tidak ditemukan.");
        return { request };
      } catch (error) {
        if (error.message === "REMEDIAL_NOT_APPROVED") {
          throw new ApiError(409, "Setujui permintaan remedial sebelum menjadwalkan ujian.");
        }
        if (error.message === "REMEDIAL_EXAM_INVALID") {
          throw new ApiError(400, "Ujian harus dipublikasikan untuk kelas dan mata pelajaran siswa.");
        }
        throw error;
      }
    },
  };
}
