import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const serverDirectory = dirname(fileURLToPath(import.meta.url));
const migrations = [
  { version: 1, path: "migrations/001_initial.sql" },
  { version: 2, path: "migrations/002_teacher_workflows.sql" },
  { version: 3, path: "migrations/003_question_import.sql" },
  { version: 4, path: "migrations/004_teacher_lms.sql" },
  { version: 5, path: "migrations/005_teacher_profile.sql" },
  { version: 6, path: "migrations/006_exam_visibility.sql" },
  { version: 7, path: "migrations/007_simple_classes.sql" },
  { version: 8, path: "migrations/008_exam_tokens_and_points.sql" },
  { version: 9, path: "migrations/009_exam_editing.sql" },
  { version: 10, path: "migrations/010_teacher_assignments_and_exam_activity.sql" },
  { version: 11, path: "migrations/011_user_account_status.sql" },
  { version: 12, path: "migrations/012_exam_kkm_remedial.sql" },
  { version: 13, path: "migrations/013_admin_password_reset_logs.sql" },
  { version: 14, path: "migrations/014_school_directory_and_status.sql" },
  { version: 15, path: "migrations/015_standard_classes_for_all_schools.sql" },
  { version: 16, path: "migrations/016_exam_score_visibility.sql" },
  { version: 17, path: "migrations/017_exam_exit_activity.sql" },
  { version: 18, path: "migrations/018_sman2_xi_class_names.sql" },
  { version: 19, path: "migrations/019_remove_question_bank.sql" },
];

export const latestSchemaVersion = migrations.at(-1).version;

export function createDatabase(config) {
  const pool = new Pool(config.url
    ? { connectionString: config.url, max: config.max, ssl: config.ssl ? { rejectUnauthorized: true } : undefined }
    : {
      host: config.host,
      port: config.port,
      database: config.name,
      user: config.user,
      password: config.password,
      max: config.max,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    });
  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error:", error);
  });
  return pool;
}

export async function migrateDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(1380863301)");
    await applyMigrations(client);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(1380863301)");
    } finally {
      client.release();
    }
  }
}

async function applyMigrations(client) {
  for (const migration of migrations) {
    const { rows } = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [migration.version],
    );
    if (rows.length) continue;

    const sql = await readFile(resolve(serverDirectory, migration.path), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [migration.version],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

export async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
