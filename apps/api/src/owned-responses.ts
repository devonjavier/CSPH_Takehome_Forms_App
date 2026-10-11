import type { Pool } from "pg";
import { HttpError } from "./errors.js";

export const responsePageSize = 50;

export async function listOwnedResponses(
  pool: Pool,
  ownerId: string,
  formId: string,
  page: number,
) {
  // Ownership, archive visibility, count and page share one statement snapshot.
  // An accessible empty form returns a row; an inaccessible form returns none.
  const result = await pool.query(
    `SELECT f.id,COALESCE(NULLIF(d.definition->>'title',''),'Untitled form') AS title,
      (SELECT count(*)::int FROM responses r JOIN form_versions v ON v.id=r.form_version_id WHERE v.form_id=f.id) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry."submittedAt" DESC,entry.id DESC) FROM (
        SELECT r.id,r.email,r.submitted_at AS "submittedAt",v.version_number AS "versionNumber"
        FROM responses r JOIN form_versions v ON v.id=r.form_version_id
        WHERE v.form_id=f.id ORDER BY r.submitted_at DESC,r.id DESC LIMIT $3 OFFSET $4
      ) entry),'[]'::jsonb) AS responses
     FROM forms f LEFT JOIN form_drafts d ON d.form_id=f.id
     WHERE f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`,
    [formId, ownerId, responsePageSize, page * responsePageSize],
  );
  const form = result.rows[0];
  if (!form) throw new HttpError(404, "NOT_FOUND", "Form not found.");
  return {
    form: { id: form.id, title: form.title },
    responses: form.responses,
    total: form.total,
    page,
    pageSize: responsePageSize,
  };
}

export async function readOwnedResponse(
  pool: Pool,
  ownerId: string,
  formId: string,
  responseId: string,
) {
  // Start from the response's original version, never the current pointer/draft.
  // LEFT JOIN answers preserves unanswered questions in older/sparse records.
  const result = await pool.query(
    `SELECT r.id,r.email,r.submitted_at AS "submittedAt",v.id AS "formVersionId",
      v.version_number AS "versionNumber",v.title,v.description,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'questionId',q.id,'label',q.label,
        'value',COALESCE(a.text_value,a.date_value::text,a.integer_value::text),
        'selectedOptions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'label',o.label) ORDER BY s.selection_position)
          FROM answer_selections s JOIN question_options o ON o.id=s.option_id AND o.question_id=q.id
          WHERE s.answer_id=a.id),'[]'::jsonb)) ORDER BY q.position)
        FROM version_questions q LEFT JOIN answers a ON a.question_id=q.id AND a.response_id=r.id AND a.form_version_id=v.id
        WHERE q.form_version_id=v.id),'[]'::jsonb) AS answers
     FROM responses r JOIN form_versions v ON v.id=r.form_version_id
     JOIN forms f ON f.id=v.form_id
     WHERE r.id=$3 AND f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`,
    [formId, ownerId, responseId],
  );
  const response = result.rows[0];
  if (!response) throw new HttpError(404, "NOT_FOUND", "Response not found.");
  return response;
}
