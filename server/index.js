import { createApp } from "./app.js";
import { latestSchemaVersion } from "./database.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config);
try {
  await app.locals.database.query("SELECT 1");
  const { rows: [schema] } = await app.locals.database.query(
    "SELECT MAX(version)::INTEGER AS version FROM schema_migrations",
  );
  if ((schema.version ?? 0) < latestSchemaVersion) {
    throw new Error(
      `PostgreSQL schema is outdated (version ${schema.version ?? 0}; expected ${latestSchemaVersion}). Run \`npm run migrate\` first.`,
    );
  }
} catch (error) {
  console.error("NSolve API could not connect to PostgreSQL:", error);
  await app.locals.close();
  process.exit(1);
}
const server = app.listen(config.port, config.host, () => {
  console.log(`NSolve API listening at ${config.apiUrl}`);
});

server.on("error", (error) => {
  console.error("NSolve API failed to start:", error);
  app.locals.close();
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down API.`);

  const forceClose = setTimeout(() => server.closeAllConnections(), 10_000);
  forceClose.unref();
  server.close((error) => {
    clearTimeout(forceClose);
    app.locals.close();
    if (error) {
      console.error("NSolve API shutdown failed:", error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
