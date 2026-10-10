import { Router } from "express";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";
import { uuidPattern } from "./auth.js";
import { parseDraft } from "./contracts/draft.js";
import { archiveForm, createDraft, saveDraft } from "./form-drafts.js";

// All management reads establish ownership in SQL, including direct UUID lookup.
// Never reuse these projections for public forms: drafts are owner-only data.
export function createOwnedFormsRouter(pool: Pool): Router {
  const router = Router();
  router.param("formId", (_request, _response, next, value: string) => {
    if (!uuidPattern.test(value))
      throw new HttpError(404, "NOT_FOUND", "Form not found.");
    next();
  });
  router.post("/", async (_request, response) => {
    response
      .status(201)
      .json({ form: await createDraft(pool, response.locals.user.id) });
  });
  router.get("/:formId/draft", async (request, response) => {
    const result = await pool.query(
      `SELECT d.definition FROM form_drafts d JOIN forms f ON f.id=d.form_id
       WHERE f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`,
      [request.params.formId, response.locals.user.id],
    );
    if (!result.rows[0])
      throw new HttpError(404, "NOT_FOUND", "Form not found.");
    response.json({ definition: parseDraft(result.rows[0].definition) });
  });
  router.put("/:formId/draft", async (request, response) => {
    if (!request.is("application/json"))
      throw new HttpError(415, "JSON_REQUIRED", "Send application/json.");
    let definition;
    try {
      definition = parseDraft(request.body);
    } catch (error) {
      throw new HttpError(
        400,
        "INVALID_DRAFT",
        error instanceof Error ? error.message : "Invalid draft.",
      );
    }
    await saveDraft(
      pool,
      response.locals.user.id,
      String(request.params.formId),
      definition,
    );
    response.status(204).end();
  });
  router.delete("/:formId", async (request, response) => {
    await archiveForm(
      pool,
      response.locals.user.id,
      String(request.params.formId),
    );
    response.status(204).end();
  });
  router.get("/", async (_request, response) => {
    const forms = await pool.query(
      `SELECT f.id,f.slug,f.is_published AS "isPublished",
        COALESCE(NULLIF(d.definition->>'title',''),'Untitled form') AS title
       FROM forms f LEFT JOIN form_drafts d ON d.form_id=f.id
       WHERE f.owner_id=$1 AND f.deleted_at IS NULL ORDER BY f.created_at DESC,f.id`,
      [response.locals.user.id],
    );
    response.json({ forms: forms.rows });
  });
  router.get("/:formId", async (request, response) => {
    const formId = request.params.formId;
    if (typeof formId !== "string" || !uuidPattern.test(formId))
      throw new HttpError(404, "NOT_FOUND", "Form not found.");
    const result = await pool.query(
      `SELECT f.id,f.slug,f.is_published AS "isPublished",
        COALESCE(NULLIF(d.definition->>'title',''),'Untitled form') AS title
       FROM forms f LEFT JOIN form_drafts d ON d.form_id=f.id
       WHERE f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`,
      [formId, response.locals.user.id],
    );
    const form = result.rows[0];
    if (!form) throw new HttpError(404, "NOT_FOUND", "Form not found.");
    response.json({ form });
  });
  return router;
}
