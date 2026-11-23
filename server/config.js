import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: resolve(projectDirectory, ".env") });

function readPositiveInteger(value, name, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const jwtSecret = env.JWT_SECRET;
  if (typeof jwtSecret !== "string" || Buffer.byteLength(jwtSecret) < 32) {
    throw new Error("JWT_SECRET must contain at least 32 bytes.");
  }

  const sameSite = (env.COOKIE_SAME_SITE ?? "Lax").toLowerCase();
  if (!["lax", "strict", "none"].includes(sameSite)) {
    throw new Error("COOKIE_SAME_SITE must be Lax, Strict, or None.");
  }

  const nodeEnv = env.NODE_ENV ?? "development";
  const seedValue = env.SEED_DEMO_DATA;
  if (seedValue !== undefined && seedValue !== "true" && seedValue !== "false") {
    throw new Error("SEED_DEMO_DATA must be true or false.");
  }
  const seedDemoData = seedValue === undefined
    ? nodeEnv !== "production"
    : seedValue === "true";
  if (env.COOKIE_SECURE !== undefined &&
      env.COOKIE_SECURE !== "true" && env.COOKIE_SECURE !== "false") {
    throw new Error("COOKIE_SECURE must be true or false.");
  }
  const secureCookie = env.COOKIE_SECURE
    ? env.COOKIE_SECURE === "true"
    : nodeEnv === "production";
  if (nodeEnv === "production" && !secureCookie) {
    throw new Error("COOKIE_SECURE must be true in production.");
  }
  if (sameSite === "none" && !secureCookie) {
    throw new Error("COOKIE_SAME_SITE=None requires COOKIE_SECURE=true.");
  }

  if (nodeEnv === "production" && !env.FRONTEND_ORIGINS) {
    throw new Error("FRONTEND_ORIGINS must be configured in production.");
  }

  const database = {
    host: env.DATABASE_HOST ?? "localhost",
    port: readPositiveInteger(env.DATABASE_PORT, "DATABASE_PORT", 5432),
    name: env.DATABASE_NAME ?? "nsolve",
    user: env.DATABASE_USER ?? "postgres",
    password: env.DATABASE_PASSWORD ?? "",
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL === "true",
    max: readPositiveInteger(env.DATABASE_POOL_MAX, "DATABASE_POOL_MAX", 10),
  };
  if (database.url && !/^postgres(?:ql)?:\/\//i.test(database.url)) {
    throw new Error(
      "DATABASE_URL must be a PostgreSQL connection string; SQLite files are no longer supported.",
    );
  }
  if (!database.url && (!database.host || !database.name || !database.user)) {
    throw new Error("DATABASE_HOST, DATABASE_NAME, and DATABASE_USER are required.");
  }
  if (!database.url && !database.password) {
    throw new Error("Set DATABASE_PASSWORD or DATABASE_URL for PostgreSQL.");
  }
  if (nodeEnv === "production" && !database.url && !database.ssl) {
    throw new Error("Production PostgreSQL requires DATABASE_SSL=true.");
  }

  const port = readPositiveInteger(env.PORT, "PORT", 3001);
  const host = env.HOST ?? "0.0.0.0";
  const apiUrl = env.API_URL ?? `http://localhost:${port}`;
  const frontendOrigins = (env.FRONTEND_ORIGINS ?? "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (frontendOrigins.length === 0) {
    throw new Error("FRONTEND_ORIGINS must contain at least one origin.");
  }
  for (const origin of frontendOrigins) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error(`Invalid frontend origin: ${origin}`);
    }
    if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
      throw new Error(`FRONTEND_ORIGINS must contain origins without paths: ${origin}`);
    }
  }

  return {
    apiUrl,
    database,
    frontendOrigins,
    host,
    jwtExpiresInSeconds: readPositiveInteger(
      env.JWT_EXPIRES_IN_SECONDS,
      "JWT_EXPIRES_IN_SECONDS",
      14 * 24 * 60 * 60,
    ),
    jwtSecret,
    nodeEnv,
    seedDemoData,
    port,
    secureCookie,
    cookieSameSite: sameSite[0].toUpperCase() + sameSite.slice(1),
    authRateLimitWindowMs: readPositiveInteger(
      env.AUTH_RATE_LIMIT_WINDOW_MS,
      "AUTH_RATE_LIMIT_WINDOW_MS",
      15 * 60 * 1000,
    ),
    authRateLimitMax: readPositiveInteger(
      env.AUTH_RATE_LIMIT_MAX,
      "AUTH_RATE_LIMIT_MAX",
      20,
    ),
    trustProxy: env.TRUST_PROXY === "true",
  };
}
