import { readPublicForm } from "./public-definition.js";
import { Router, json } from "express";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";
import { submitResponse } from "./responses.js";
import { parseSubmission, SubmissionError } from "./contracts/submission.js";
import { scheduleWebhook } from "./webhooks.js";

export function createPublicFormsRouter(pool: Pool): Router {
  const router = Router();
  router.get("/:slug", async (request, response) => {
    response.json({ form: await readPublicForm(pool, request.params.slug) });
  });
  router.post(
    "/:slug/responses",
    json({ limit: "2mb" }),
    async (request, response) => {
      if (!request.is("application/json"))
        throw new HttpError(415, "JSON_REQUIRED", "Send application/json.");
      try {
        const submission = parseSubmission(request.body);
        const result = await submitResponse(
          pool,
          request.params.slug,
          submission,
        );
        response.status(201).json({ response: result.response });
        scheduleWebhook(pool, result.webhook);
      } catch (error) {
        if (error instanceof SubmissionError)
          throw new HttpError(
            400,
            "INVALID_SUBMISSION",
            error.message,
            error.field,
          );
        throw error;
      }
    },
  );
  return router;
}
