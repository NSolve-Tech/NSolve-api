import { ApiError } from "./services.js";

const SESSION_COOKIE = "nsolve_session";

function readCookie(request, name) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const prefix = `${name}=`;
  const cookie = cookies.map((value) => value.trim()).find((value) => value.startsWith(prefix));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return null;
  }
}

function sessionCookie(token, { maxAgeSeconds, sameSite, secure }) {
  const secureAttribute = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAgeSeconds}${secureAttribute}`;
}

export function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let content = "";
  for await (const chunk of request) {
    content += chunk;
    if (content.length > 64 * 1024) throw new ApiError(413, "Ukuran data terlalu besar.");
  }
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch {
    throw new ApiError(400, "Format JSON tidak valid.");
  }
}

export function createController(service, teacherService, adminService, cookieOptions) {
  return async function handleApi(request, response) {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";
    const token = readCookie(request, SESSION_COOKIE);

    if (method === "GET" && path === "/api/auth/me") {
      return sendJson(response, 200, { user: await service.currentUser(token) });
    }
    if (method === "POST" && path === "/api/auth/register") {
      const result = await service.register(await readJson(request));
      return sendJson(response, 201, { user: result.user }, {
        "set-cookie": sessionCookie(result.token, cookieOptions),
      });
    }
    if (method === "GET" && path === "/api/public/registration-options") {
      return sendJson(response, 200, await service.getRegistrationOptions(
        url.searchParams.get("schoolId") ?? undefined,
      ));
    }
    if (method === "POST" && path === "/api/auth/login") {
      const result = await service.login(await readJson(request));
      return sendJson(response, 200, { user: result.user }, {
        "set-cookie": sessionCookie(result.token, cookieOptions),
      });
    }
    if (method === "POST" && path === "/api/auth/logout") {
      await service.logout(token);
      return sendJson(response, 200, { loggedOut: true }, {
        "set-cookie": sessionCookie("", { ...cookieOptions, maxAgeSeconds: 0 }),
      });
    }
    if (method === "GET" && path === "/api/student/profile") {
      return sendJson(response, 200, await service.getStudentProfile(token));
    }
    if (method === "PUT" && path === "/api/student/profile") {
      return sendJson(response, 200, await service.updateStudentProfile(token, await readJson(request)));
    }
    if (method === "GET" && path === "/api/student/exams") {
      return sendJson(response, 200, await service.listExams(token));
    }

    if (path.startsWith("/api/admin/")) {
      const authenticatedAdmin = await service.requireRole(token, ["admin"]);
      if (method === "GET" && path === "/api/admin/schools") {
        return sendJson(response, 200, await adminService.listSchools(authenticatedAdmin));
      }
      if (method === "POST" && path === "/api/admin/schools") {
        return sendJson(response, 201, await adminService.createSchool(
          authenticatedAdmin, await readJson(request),
        ));
      }
      const platformSchoolRoute = path.match(/^\/api\/admin\/schools\/([^/]+)$/);
      if (platformSchoolRoute && method === "PUT") {
        return sendJson(response, 200, await adminService.updatePlatformSchool(
          authenticatedAdmin,
          decodeURIComponent(platformSchoolRoute[1]),
          await readJson(request),
        ));
      }
      if (platformSchoolRoute && method === "DELETE") {
        return sendJson(response, 200, await adminService.deleteSchool(
          authenticatedAdmin,
          decodeURIComponent(platformSchoolRoute[1]),
        ));
      }
      if (method === "PUT" && path === "/api/admin/profile") {
        return sendJson(response, 200, await adminService.updateProfile(
          authenticatedAdmin, await readJson(request),
        ));
      }
      const admin = await adminService.scopeAdmin(
        authenticatedAdmin,
        url.searchParams.get("schoolId"),
      );
      if (method === "GET" && path === "/api/admin/teacher-assignments") {
        return sendJson(response, 200, await adminService.listTeacherAssignments(admin));
      }
      const teacherAssignmentRoute = path.match(/^\/api\/admin\/teachers\/([^/]+)\/classes$/);
      if (method === "PUT" && teacherAssignmentRoute) {
        return sendJson(response, 200, await adminService.setTeacherClasses(
          admin,
          decodeURIComponent(teacherAssignmentRoute[1]),
          await readJson(request),
        ));
      }
      if (method === "GET" && path === "/api/admin/exam-activity") {
        return sendJson(response, 200, await adminService.listExamActivity(admin));
      }
      if (method === "GET" && path === "/api/admin/users") {
        return sendJson(response, 200, await adminService.listUsers(
          admin,
          url.searchParams.get("role") ?? undefined,
        ));
      }
      if (method === "POST" && path === "/api/admin/users") {
        return sendJson(response, 201, await adminService.createUser(admin, await readJson(request)));
      }
      const passwordResetHistoryRoute = path.match(/^\/api\/admin\/users\/([^/]+)\/password-resets$/);
      if (method === "GET" && passwordResetHistoryRoute) {
        return sendJson(response, 200, await adminService.listPasswordResetLogs(
          admin,
          decodeURIComponent(passwordResetHistoryRoute[1]),
        ));
      }
      const passwordResetRoute = path.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
      if (method === "POST" && passwordResetRoute) {
        return sendJson(response, 200, await adminService.resetPassword(
          admin,
          decodeURIComponent(passwordResetRoute[1]),
        ));
      }
      const adminUserRoute = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserRoute) {
        const userId = decodeURIComponent(adminUserRoute[1]);
        if (method === "PUT") {
          return sendJson(response, 200, await adminService.updateUser(
            admin, userId, await readJson(request),
          ));
        }
        if (method === "DELETE") {
          return sendJson(response, 200, await adminService.deleteUser(admin, userId));
        }
      }
      if (method === "GET" && path === "/api/admin/exams") {
        return sendJson(response, 200, await adminService.listExams(admin));
      }
      const adminExamTokenRoute = path.match(/^\/api\/admin\/exams\/([^/]+)\/token$/);
      if (method === "PUT" && adminExamTokenRoute) {
        return sendJson(response, 200, await adminService.updateExamToken(
          admin,
          decodeURIComponent(adminExamTokenRoute[1]),
          await readJson(request),
        ));
      }
      if (method === "GET" && path === "/api/admin/classes") {
        return sendJson(response, 200, await adminService.listClasses(admin));
      }
      if (method === "POST" && path === "/api/admin/classes") {
        return sendJson(response, 201, await adminService.saveClass(
          admin, null, await readJson(request),
        ));
      }
      const adminClassRoute = path.match(/^\/api\/admin\/classes\/([^/]+)$/);
      if (adminClassRoute) {
        const classId = decodeURIComponent(adminClassRoute[1]);
        if (method === "PUT") {
          return sendJson(response, 200, await adminService.saveClass(
            admin, classId, await readJson(request),
          ));
        }
        if (method === "DELETE") {
          return sendJson(response, 200, await adminService.deleteClass(admin, classId));
        }
      }
      if (method === "GET" && path === "/api/admin/subjects") {
        return sendJson(response, 200, await adminService.listSubjects(admin));
      }
      if (method === "POST" && path === "/api/admin/subjects") {
        return sendJson(response, 201, await adminService.saveSubject(
          admin, null, await readJson(request),
        ));
      }
      const adminSubjectRoute = path.match(/^\/api\/admin\/subjects\/([^/]+)$/);
      if (adminSubjectRoute) {
        const subjectId = decodeURIComponent(adminSubjectRoute[1]);
        if (method === "PUT") {
          return sendJson(response, 200, await adminService.saveSubject(
            admin, subjectId, await readJson(request),
          ));
        }
        if (method === "DELETE") {
          return sendJson(response, 200, await adminService.deleteSubject(admin, subjectId));
        }
      }
      if (method === "GET" && path === "/api/admin/school") {
        return sendJson(response, 200, await adminService.getSchool(admin));
      }
      if (method === "PUT" && path === "/api/admin/school") {
        return sendJson(response, 200, await adminService.updateSchool(admin, await readJson(request)));
      }
    }

    if (path.startsWith("/api/teacher/")) {
      const teacher = await service.requireRole(token, ["teacher"]);
      if (method === "GET" && path === "/api/teacher/dashboard") {
        return sendJson(response, 200, await teacherService.dashboard(teacher));
      }
      if (method === "GET" && path === "/api/teacher/profile") {
        return sendJson(response, 200, await teacherService.getProfile(teacher));
      }
      if (method === "GET" && path === "/api/teacher/subjects") {
        return sendJson(response, 200, await teacherService.listSubjects(teacher));
      }
      if (method === "PUT" && path === "/api/teacher/profile") {
        return sendJson(response, 200, await teacherService.updateProfile(
          teacher,
          await readJson(request),
        ));
      }
      if (method === "GET" && path === "/api/teacher/questions") {
        return sendJson(response, 200, await teacherService.listQuestions(teacher, {
          subject: url.searchParams.get("subject") ?? "",
          gradeLevel: url.searchParams.get("gradeLevel") ?? "",
          chapter: url.searchParams.get("chapter") ?? "",
          difficulty: url.searchParams.get("difficulty") ?? "",
          type: url.searchParams.get("type") ?? "",
          search: url.searchParams.get("search") ?? "",
          page: url.searchParams.get("page") ?? "1",
          pageSize: url.searchParams.get("pageSize") ?? "10",
        }));
      }
      if (method === "POST" && path === "/api/teacher/questions") {
        return sendJson(response, 201, await teacherService.createQuestion(teacher, await readJson(request)));
      }
      if (method === "POST" && path === "/api/teacher/questions/import") {
        return sendJson(response, 201, await teacherService.importQuestions(teacher, await readJson(request)));
      }
      if (method === "GET" && path === "/api/teacher/participants") {
        return sendJson(response, 200, await teacherService.participants(teacher));
      }
      if (method === "GET" && path === "/api/teacher/results") {
        return sendJson(response, 200, await teacherService.results(teacher));
      }
      if (method === "GET" && path === "/api/teacher/remedial-requests") {
        return sendJson(response, 200, await teacherService.listRemedialRequests(teacher));
      }
      const remedialScheduleRoute = path.match(
        /^\/api\/teacher\/remedial-requests\/([^/]+)\/schedule$/,
      );
      if (method === "POST" && remedialScheduleRoute) {
        return sendJson(response, 200, await teacherService.scheduleRemedialRequest(
          teacher,
          decodeURIComponent(remedialScheduleRoute[1]),
          await readJson(request),
        ));
      }
      const remedialRequestRoute = path.match(/^\/api\/teacher\/remedial-requests\/([^/]+)$/);
      if (method === "PUT" && remedialRequestRoute) {
        return sendJson(response, 200, await teacherService.updateRemedialRequest(
          teacher,
          decodeURIComponent(remedialRequestRoute[1]),
          await readJson(request),
        ));
      }
      if (method === "GET" && path === "/api/teacher/classes") {
        return sendJson(response, 200, await teacherService.listClasses(teacher));
      }
      if (method === "GET" && path === "/api/teacher/available-classes") {
        return sendJson(response, 200, await teacherService.listAvailableClasses(teacher));
      }
      if (method === "GET" && path === "/api/teacher/exams") {
        return sendJson(response, 200, await teacherService.listExams(teacher));
      }
      if (method === "POST" && path === "/api/teacher/exams") {
        return sendJson(response, 201, await teacherService.createExam(teacher, await readJson(request)));
      }
      const examTokenRoute = path.match(/^\/api\/teacher\/exams\/([^/]+)\/token$/);
      if (method === "PUT" && examTokenRoute) {
        return sendJson(response, 200, await teacherService.updateExamToken(
          teacher,
          decodeURIComponent(examTokenRoute[1]),
          await readJson(request),
        ));
      }

      const questionRoute = path.match(/^\/api\/teacher\/questions\/([^/]+)$/);
      if (method === "GET" && questionRoute) {
        return sendJson(response, 200, await teacherService.getQuestion(
          teacher,
          decodeURIComponent(questionRoute[1]),
        ));
      }
      if (method === "PUT" && questionRoute) {
        return sendJson(response, 200, await teacherService.updateQuestion(
          teacher,
          decodeURIComponent(questionRoute[1]),
          await readJson(request),
        ));
      }
      if (method === "DELETE" && questionRoute) {
        return sendJson(response, 200, await teacherService.deleteQuestion(
          teacher,
          decodeURIComponent(questionRoute[1]),
        ));
      }
      const examActionRoute = path.match(
        /^\/api\/teacher\/exams\/([^/]+)\/(participants|publish|analytics)$/,
      );
      if (examActionRoute) {
        const examId = decodeURIComponent(examActionRoute[1]);
        const action = examActionRoute[2];
        if (method === "GET" && action === "analytics") {
          return sendJson(response, 200, await teacherService.analytics(teacher, examId));
        }
        if (method === "POST" && action === "publish") {
          return sendJson(response, 200, await teacherService.publishExam(
            teacher, examId, await readJson(request),
          ));
        }
      }
      const examRoute = path.match(/^\/api\/teacher\/exams\/([^/]+)$/);
      if (method === "GET" && examRoute) {
        return sendJson(response, 200, await teacherService.getExam(
          teacher,
          decodeURIComponent(examRoute[1]),
        ));
      }
      if (method === "PUT" && examRoute) {
        return sendJson(response, 200, await teacherService.updateExam(
          teacher,
          decodeURIComponent(examRoute[1]),
          await readJson(request),
        ));
      }
      if (method === "DELETE" && examRoute) {
        return sendJson(response, 200, await teacherService.deleteExam(
          teacher,
          decodeURIComponent(examRoute[1]),
        ));
      }
    }

    const questionRoute = path.match(/^\/api\/student\/exams\/([^/]+)\/questions$/);
    if (method === "GET" && questionRoute) {
      return sendJson(response, 200, await service.getQuestions(
        token,
        decodeURIComponent(questionRoute[1]),
        url.searchParams.get("attemptId"),
      ));
    }

    const examRoute = path.match(/^\/api\/student\/exams\/([^/]+)(?:\/(start|save-answer|submit|activity))?$/);
    if (examRoute) {
      const examId = decodeURIComponent(examRoute[1]);
      const action = examRoute[2];
      if (method === "GET" && !action) {
        return sendJson(response, 200, await service.getExam(token, examId));
      }
      if (method === "POST" && action === "start") {
        const result = await service.startExam(token, examId, await readJson(request));
        if (result.result) {
          return sendJson(response, 200, { result: result.result, expired: true });
        }
        return sendJson(response, 201, result);
      }
      if (method === "POST" && action === "save-answer") {
        return sendJson(response, 200, await service.saveAnswer(token, examId, await readJson(request)));
      }
      if (method === "POST" && action === "submit") {
        return sendJson(response, 200, await service.submitExam(token, examId, await readJson(request)));
      }
      if (method === "POST" && action === "activity") {
        return sendJson(response, 201, await service.recordExamActivity(token, examId, await readJson(request)));
      }
    }
    if (method === "GET" && path === "/api/student/results") {
      return sendJson(response, 200, await service.listResults(token));
    }

    const remedialResultRoute = path.match(/^\/api\/student\/results\/([^/]+)\/remedial$/);
    if (method === "POST" && remedialResultRoute) {
      return sendJson(response, 201, await service.requestRemedial(
        token,
        decodeURIComponent(remedialResultRoute[1]),
      ));
    }

    const resultRoute = path.match(/^\/api\/student\/results\/([^/]+)$/);
    if (method === "GET" && resultRoute) {
      return sendJson(response, 200, await service.getResult(token, decodeURIComponent(resultRoute[1])));
    }

    throw new ApiError(404, "Endpoint tidak ditemukan.");
  };
}
