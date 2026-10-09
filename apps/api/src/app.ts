import express from "express";

export const app = express();
app.disable("x-powered-by");

// Liveness only: this must not claim that PostgreSQL is ready or connected.
app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "api" });
});

app.use((_request, response) => {
  response.status(404).json({
    error: { code: "NOT_FOUND", message: "This endpoint does not exist." },
  });
});
