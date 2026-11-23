import { createDatabase, migrateDatabase } from "./database.js";
import { loadConfig } from "./config.js";

const database = createDatabase(loadConfig().database);
try {
  await migrateDatabase(database);
  console.log("PostgreSQL migrations applied successfully.");
} finally {
  await database.end();
}
