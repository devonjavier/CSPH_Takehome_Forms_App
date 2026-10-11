import { createHash, timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";

const historyLimit = 50;
const digest = (secret: string) => createHash("sha256").update(secret).digest();
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function createConsumerApp(secret: string) {
  if (!/^[\x21-\x7e]{1,512}$/.test(secret)) {
    throw new Error(
      "WEBHOOK_SECRET must contain 1–512 visible ASCII characters without spaces.",
    );
  }
  const expectedSecret = digest(secret);
  const received: { receivedAt: string; payload: unknown }[] = [];
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    response.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    next();
  });
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "webhook-consumer" });
  });
  app.post(
    "/webhooks",
    (request, response, next) => {
      // Compare fixed-length digests, and authenticate before parsing any body.
      const supplied = request.headersDistinct["x-webhook-secret"];
      if (
        supplied?.length !== 1 ||
        !timingSafeEqual(digest(supplied[0] ?? ""), expectedSecret)
      ) {
        response.status(401).json({ error: "Invalid webhook secret." });
        return;
      }
      if (!request.is("application/json")) {
        response.status(415).json({ error: "Use application/json." });
        return;
      }
      next();
    },
    // Historical labels add bytes to the producer's accepted 2 MiB submission.
    express.json({ limit: "4mb", inflate: false }),
    (request, response) => {
      // This demo retains the JSON payload verbatim; the producer owns its schema.
      const payload: unknown = request.body;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        response.status(400).json({ error: "Send a JSON object." });
        return;
      }
      received.unshift({ receivedAt: new Date().toISOString(), payload });
      if (received.length > historyLimit) received.pop();
      response.sendStatus(204);
    },
  );
  app.get("/", (_request, response) => {
    const entries = received
      .map(
        (entry) =>
          `<article><h2>Received ${escapeHtml(entry.receivedAt)}</h2><pre>${escapeHtml(JSON.stringify(entry.payload, null, 2))}</pre></article>`,
      )
      .join("");
    response
      .type("html")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Webhook consumer</title><style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:60rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:1rem}h2{font-size:1rem}a:focus-visible{outline:3px solid blue}</style></head><body><main><h1>Webhook consumer</h1><p>Latest ${historyLimit} deliveries, newest first. Memory only: restarting clears this list.</p><p><a href="/">Refresh deliveries</a></p>${entries || "<p>No deliveries received yet.</p>"}</main></body></html>`,
      );
  });
  app.use((_request, response) => {
    response.status(404).json({ error: "This endpoint does not exist." });
  });
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    next,
  ) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : 500;
    const safeStatus =
      status === 400 || status === 413 || status === 415 ? status : 500;
    let message = "Could not accept payload.";
    if (safeStatus === 413) message = "Payload too large.";
    if (safeStatus === 415) message = "Unsupported encoding.";
    response.status(safeStatus).json({ error: message });
  };
  app.use(handleError);
  return app;
}
