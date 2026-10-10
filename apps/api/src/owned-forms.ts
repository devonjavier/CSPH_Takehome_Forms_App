import { Router } from "express";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";
import { uuidPattern } from "./auth.js";

// All management reads establish ownership in SQL, including direct UUID lookup.
// Never reuse these projections for public forms: drafts are owner-only data.
export function createOwnedFormsRouter(pool: Pool): Router {
  const router = Router();
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
