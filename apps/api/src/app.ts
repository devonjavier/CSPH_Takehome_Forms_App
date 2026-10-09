import express from "express";
import type { Pool } from "pg";

export function createApp(pool: Pool) {
  const app = express();
  app.disable("x-powered-by");

  // Liveness only: this must not claim that PostgreSQL is ready or connected.
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "api" });
  });

  app.get("/ready", async (_request, response) => {
    try {
      await pool.query("SELECT 1");
      response.json({ status: "ok", service: "api", database: "available" });
    } catch {
      response.status(503).json({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "The database is temporarily unavailable.",
        },
      });
    }
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "This endpoint does not exist." },
    });
  });
  return app;
}
