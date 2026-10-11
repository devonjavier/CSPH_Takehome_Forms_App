import { Router } from "express";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";

export function createPublicFormsRouter(pool: Pool): Router {
  const router = Router();
  router.get("/:slug", async (request, response) => {
    // One statement gives a consistent snapshot of visibility, pointer and tree.
    // Never join form_drafts or project owner/webhook information here.
    const result = await pool.query(
      `SELECT v.id AS "formVersionId",v.version_number AS "versionNumber",v.title,v.description,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id',q.id,'label',q.label,'type',q.type,'required',q.required,'position',q.position,
          'min',q.scale_min,'max',q.scale_max,'minLabel',q.scale_min_label,'maxLabel',q.scale_max_label,
          'options',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'label',o.label,'position',o.position) ORDER BY o.position)
            FROM question_options o WHERE o.question_id=q.id),'[]'::jsonb)) ORDER BY q.position)
          FROM version_questions q WHERE q.form_version_id=v.id),'[]'::jsonb) AS questions
       FROM forms f JOIN form_versions v ON v.id=f.current_version_id AND v.form_id=f.id
       WHERE f.slug=$1 AND f.is_published AND f.deleted_at IS NULL`,
      [request.params.slug],
    );
    if (!result.rows[0])
      throw new HttpError(404, "NOT_FOUND", "Form not found.");
    response.json({ form: result.rows[0] });
  });
  return router;
}
