import express from "express";
import type { Pool } from "pg";
import {
  authenticate,
  createAuthRouter,
  requireTrustedOrigin,
  type AuthConfig,
} from "./auth.js";
import { createOwnedFormsRouter } from "./owned-forms.js";
import { handleError } from "./errors.js";

export function createApp(pool: Pool, authConfig: AuthConfig) {
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

  app.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use(requireTrustedOrigin(authConfig));
  app.use(
    "/auth",
    express.json({ limit: "16kb" }),
    createAuthRouter(pool, authConfig),
  );
  app.use(
    "/forms",
    authenticate(pool, authConfig),
    express.json({ limit: "256kb" }),
    createOwnedFormsRouter(pool),
  );

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "This endpoint does not exist." },
    });
  });
  app.use(handleError);
  return app;
}
