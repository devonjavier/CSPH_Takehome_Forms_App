import { createApp } from "./app.js";
import { createDatabasePool } from "./database.js";
import { readAuthConfig } from "./auth.js";

const port = Number(process.env.PORT ?? "4000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

async function startServer() {
  const authConfig = readAuthConfig();
  const pool = createDatabasePool();
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    throw new Error(
      "Database connection failed. Check the API environment and PostgreSQL service.",
    );
  }

  const server = createApp(pool, authConfig).listen(port);
  server.once("listening", () => {
    console.log(`Forms API listening on http://localhost:${port}`);
  });
  let shuttingDown = false;
  function shutdown(exitCode: number) {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    // Drain HTTP requests first: in-flight operations may still need the pool.
    server.close(() => {
      void pool
        .end()
        .then(() => {
          clearTimeout(deadline);
          process.exitCode = exitCode;
        })
        .catch(() => {
          console.error("Database shutdown failed.");
          process.exitCode = 1;
        });
    });
  }
  server.once("error", () => {
    console.error("API listener failed. Check the configured port.");
    shutdown(1);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => shutdown(0));
  }
}

void startServer().catch(() => {
  console.error(
    "API startup failed. Check PORT, PG*, JWT_SECRET, WEB_ORIGIN and database availability.",
  );
  process.exitCode = 1;
});
