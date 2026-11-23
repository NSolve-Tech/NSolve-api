import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { ApiError } from "./services.js";
import { createDatabase } from "./database.js";
import { createStudentModel } from "./models.js";
import { createTeacherModel } from "./teacher-model.js";
import { createStudentService } from "./services.js";
import { createTeacherService } from "./teacher-service.js";
import { createAdminModel } from "./admin-model.js";
import { createAdminService } from "./admin-service.js";
import { createController, sendJson } from "./controller.js";

export function createApp(config, { database = createDatabase(config.database) } = {}) {
  const model = createStudentModel(database);
  const teacherModel = createTeacherModel(database);
  const adminModel = createAdminModel(database);
  const service = createStudentService(model, {
    jwtSecret: config.jwtSecret,
    tokenTtlSeconds: config.jwtExpiresInSeconds,
  });
  const teacherService = createTeacherService(teacherModel);
  const adminService = createAdminService(adminModel);
  const controller = createController(service, teacherService, adminService, {
    secure: config.secureCookie,
    sameSite: config.cookieSameSite,
    maxAgeSeconds: config.jwtExpiresInSeconds,
  });
  const allowedOrigins = new Set(config.frontendOrigins);
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(helmet({
    strictTransportSecurity: config.nodeEnv === "production" ? undefined : false,
  }));
  app.use(cors({
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      if (allowedOrigins.has(origin)) return callback(null, origin);
      return callback(new ApiError(403, "Origin tidak diizinkan."));
    },
  }));
  app.use((request, response, next) => {
    const origin = request.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      next(new ApiError(403, "Origin tidak diizinkan."));
      return;
    }
    next();
  });
  app.use("/api/auth/login", rateLimit({
    windowMs: config.authRateLimitWindowMs,
    limit: config.authRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler(request, response) {
      sendJson(response, 429, { error: "Terlalu banyak percobaan. Coba lagi nanti." });
    },
  }));
  app.use("/api/auth/register", rateLimit({
    windowMs: config.authRateLimitWindowMs,
    limit: config.authRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler(request, response) {
      sendJson(response, 429, { error: "Terlalu banyak percobaan. Coba lagi nanti." });
    },
  }));
  const healthCheck = async (request, response) => {
    await database.query("SELECT 1");
    sendJson(response, 200, { status: "ok", database: "postgres" });
  };
  app.get("/health", healthCheck);
  app.get("/api/health", healthCheck);
  app.use((request, response, next) => {
    if (!request.path.startsWith("/api/")) {
      next();
      return;
    }
    controller(request, response).catch(next);
  });
  app.use((request, response) => {
    sendJson(response, 404, { error: "Endpoint tidak ditemukan." });
  });
  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status = error instanceof ApiError ? error.status : 500;
    if (status >= 500) console.error("API request failed:", error);
    sendJson(response, status, {
      error: status === 500 ? "Terjadi kesalahan pada server." : error.message,
    });
  });

  app.locals.database = database;
  app.locals.close = () => database.end();
  return app;
}
