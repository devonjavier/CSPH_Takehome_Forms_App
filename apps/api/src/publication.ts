import type { Pool } from "pg";
import { parseDraft, type DraftDefinition } from "./contracts/draft.js";
import { validatePublication } from "./contracts/publication.js";
import { withTransaction } from "./database.js";
import { HttpError } from "./errors.js";
import { lockOwnedForm } from "./form-drafts.js";

type PublicationResult = { id: string; versionNumber: number };
export function publishForm(
  pool: Pool,
  ownerId: string,
  formId: string,
  actionId: string,
  expectedDefinition: DraftDefinition,
) {
  return withTransaction(pool, async (client) => {
    await lockOwnedForm(client, formId, ownerId);
    // Replay must precede draft validation: a later save or unpublish does not
    // invalidate a completed action, and replay must never move the pointer back.
    const existing = await client.query<PublicationResult>(
      'SELECT id,version_number AS "versionNumber" FROM form_versions WHERE form_id=$1 AND publication_action_id=$2',
      [formId, actionId],
    );
    if (existing.rows[0]) return { ...existing.rows[0], replayed: true };
    const stored = await client.query<{ definition: unknown }>(
      "SELECT definition FROM form_drafts WHERE form_id=$1",
      [formId],
    );
    const draft = parseDraft(stored.rows[0]?.definition);
    if (JSON.stringify(draft) !== JSON.stringify(expectedDefinition))
      throw new HttpError(
        409,
        "DRAFT_CHANGED",
        "The saved draft changed. Reload and review it before publishing.",
      );
    let definition: DraftDefinition;
    try {
      definition = validatePublication(draft);
    } catch (error) {
      throw new HttpError(
        400,
        "INVALID_PUBLICATION",
        error instanceof Error
          ? error.message
          : "Complete the draft before publishing.",
      );
    }
    const created = await client.query<PublicationResult>(
      `INSERT INTO form_versions (form_id,version_number,publication_action_id,title,description)
       SELECT $1,COALESCE(MAX(version_number),0)+1,$2,$3,$4 FROM form_versions WHERE form_id=$1
       RETURNING id,version_number AS "versionNumber"`,
      [formId, actionId, definition.title, definition.description],
    );
    const version = created.rows[0];
    if (!version) throw new Error("Publication creation failed.");
    // Generate fresh relational IDs. Draft identities must not be reused across
    // immutable versions; answers will point to these published records.
    for (const [position, question] of definition.questions.entries()) {
      const scale = question.type === "linear_scale" ? question : null;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO version_questions (form_version_id,label,type,position,required,scale_min,scale_max,scale_min_label,scale_max_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          version.id,
          question.label,
          question.type,
          position,
          question.required,
          scale?.min ?? null,
          scale?.max ?? null,
          scale?.minLabel ?? null,
          scale?.maxLabel ?? null,
        ],
      );
      const publishedQuestion = inserted.rows[0];
      if (!publishedQuestion) throw new Error("Question creation failed.");
      if ("options" in question) {
        // One statement per option set avoids up to 10,000 individual round trips.
        await client.query(
          `INSERT INTO question_options (question_id,question_type,label,position)
           SELECT $1,$2,label,(position-1)::integer FROM unnest($3::text[]) WITH ORDINALITY AS choices(label,position)`,
          [
            publishedQuestion.id,
            question.type,
            question.options.map((option) => option.label.trim()),
          ],
        );
      }
    }
    await client.query(
      "UPDATE forms SET current_version_id=$2,is_published=true WHERE id=$1",
      [formId, version.id],
    );
    return { ...version, replayed: false };
  });
}
export function unpublishForm(pool: Pool, ownerId: string, formId: string) {
  return withTransaction(pool, async (client) => {
    await lockOwnedForm(client, formId, ownerId);
    await client.query("UPDATE forms SET is_published=false WHERE id=$1", [
      formId,
    ]);
  });
}
