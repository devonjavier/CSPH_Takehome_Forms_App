import { Router, json } from "express";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";
import { uuidPattern } from "./auth.js";
import { parseDraft } from "./contracts/draft.js";
import {
  archiveForm,
  createDraft,
  saveDraft,
  draftETag,
} from "./form-drafts.js";
import { publishForm, unpublishForm } from "./publication.js";
import { listOwnedResponses, readOwnedResponse } from "./owned-responses.js";
import { buildResponseWorkbook } from "./response-export.js";
import {
  parseWebhook,
  readWebhook,
  saveWebhook,
  removeWebhook,
} from "./webhooks.js";

// All management reads establish ownership in SQL, including direct UUID lookup.
// Never reuse these projections for public forms: drafts are owner-only data.
export function createOwnedFormsRouter(pool: Pool): Router {
  const router = Router();
  // Publishing wraps the saved draft with an action ID. Reserve envelope space
  // so a draft accepted at the save limit can also be published.
  router.post("/:formId/publish", json({ limit: "257kb" }));
  router.use(json({ limit: "256kb" }));
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
  router.get("/:formId/webhook", async (request, response) => {
    response.json({
      webhook: await readWebhook(
        pool,
        response.locals.user.id,
        String(request.params.formId),
      ),
    });
  });
  router.put("/:formId/webhook", async (request, response) => {
    if (!request.is("application/json"))
      throw new HttpError(415, "JSON_REQUIRED", "Send application/json.");
    await saveWebhook(
      pool,
      response.locals.user.id,
      String(request.params.formId),
      parseWebhook(request.body),
    );
    response.status(204).end();
  });
  router.delete("/:formId/webhook", async (request, response) => {
    await removeWebhook(
      pool,
      response.locals.user.id,
      String(request.params.formId),
    );
    response.status(204).end();
  });
  router.get("/:formId/responses/export", async (request, response) => {
    const formId = String(request.params.formId);
    const workbook = await buildResponseWorkbook(
      pool,
      response.locals.user.id,
      formId,
    );
    response.type(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    response.attachment(`form-${formId}-responses.xlsx`);
    await workbook.xlsx.write(response);
    response.end();
  });
  router.get("/:formId/responses", async (request, response) => {
    const pageValue = request.query.page ?? "0";
    if (typeof pageValue !== "string" || !/^\d{1,7}$/.test(pageValue))
      throw new HttpError(
        400,
        "INVALID_PAGE",
        "Page must be a nonnegative integer of at most seven digits.",
      );
    response.json(
      await listOwnedResponses(
        pool,
        response.locals.user.id,
        String(request.params.formId),
        Number(pageValue),
      ),
    );
  });
  router.get("/:formId/responses/:responseId", async (request, response) => {
    const responseId = String(request.params.responseId);
    if (!uuidPattern.test(responseId))
      throw new HttpError(404, "NOT_FOUND", "Response not found.");
    response.json({
      response: await readOwnedResponse(
        pool,
        response.locals.user.id,
        String(request.params.formId),
        responseId,
      ),
    });
  });
  router.get("/:formId/publication", async (request, response) => {
    const result = await pool.query(
      `SELECT f.slug,f.is_published AS "isPublished",f.current_version_id AS "formVersionId",v.version_number AS "versionNumber"
       FROM forms f LEFT JOIN form_versions v ON v.id=f.current_version_id
       WHERE f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`,
      [request.params.formId, response.locals.user.id],
    );
    if (!result.rows[0])
      throw new HttpError(404, "NOT_FOUND", "Form not found.");
    response.json({ publication: result.rows[0] });
  });
  router.post("/:formId/publish", async (request, response) => {
    if (!request.is("application/json"))
      throw new HttpError(415, "JSON_REQUIRED", "Send application/json.");
    const body: unknown = request.body;
    if (
      !body ||
      typeof body !== "object" ||
      !("publicationActionId" in body) ||
      typeof body.publicationActionId !== "string" ||
      !uuidPattern.test(body.publicationActionId) ||
      !("definition" in body)
    )
      throw new HttpError(
        400,
        "INVALID_PUBLICATION",
        "Send a publication action UUID and the saved definition.",
      );
    let definition;
    try {
      definition = parseDraft(body.definition);
    } catch (error) {
      throw new HttpError(
        400,
        "INVALID_PUBLICATION",
        error instanceof Error ? error.message : "Invalid definition.",
      );
    }
    const publication = await publishForm(
      pool,
      response.locals.user.id,
      String(request.params.formId),
      body.publicationActionId,
      definition,
    );
    response.status(publication.replayed ? 200 : 201).json({ publication });
  });
  router.post("/:formId/unpublish", async (request, response) => {
    await unpublishForm(
      pool,
      response.locals.user.id,
      String(request.params.formId),
    );
    response.status(204).end();
  });
  router.get("/:formId/draft", async (request, response) => {
    const result = await pool.query(
      `SELECT d.definition FROM form_drafts d JOIN forms f ON f.id=d.form_id
       WHERE f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`,
      [request.params.formId, response.locals.user.id],
    );
    if (!result.rows[0])
      throw new HttpError(404, "NOT_FOUND", "Form not found.");
    const definition = parseDraft(result.rows[0].definition);
    const etag = draftETag(definition);
    response.set("ETag", etag).json({ definition, etag });
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
      request.get("If-Match"),
    );
    const etag = draftETag(definition);
    response.set("ETag", etag).json({ etag });
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
