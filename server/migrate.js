import { createDatabase, migrateDatabase } from "./database.js";
import { loadConfig } from "./config.js";

const migrationEnv = process.env.DATABASE_URL_UNPOOLED
  ? { ...process.env, DATABASE_URL: process.env.DATABASE_URL_UNPOOLED }
  : process.env;
const database = createDatabase(loadConfig(migrationEnv).database);
try {
  await migrateDatabase(database);
  console.log("PostgreSQL migrations applied successfully.");
} finally {
  await database.end();
}
