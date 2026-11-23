import { createDatabase } from "./database.js";
import { loadConfig } from "./config.js";
import { seedDatabase } from "./seed.js";

const config = loadConfig();
if (config.nodeEnv === "production" || !config.seedDemoData) {
  throw new Error("Demo seeding is allowed only in development with SEED_DEMO_DATA=true.");
}
const database = createDatabase(config.database);
try {
  await seedDatabase(database);
  console.log("Development seed data inserted.");
} finally {
  await database.end();
}
