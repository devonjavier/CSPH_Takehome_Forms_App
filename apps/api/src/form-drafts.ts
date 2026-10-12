import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { parseDraft, type DraftDefinition } from "./contracts/draft.js";
import { withTransaction } from "./database.js";
import { HttpError } from "./errors.js";

export function draftETag(definition: DraftDefinition): string {
  return `"${createHash("sha256")
    .update(JSON.stringify(parseDraft(definition)))
    .digest("hex")}"`;
}

export async function lockOwnedForm(
  client: PoolClient,
  formId: string,
  ownerId: string,
) {
  // Publication/submission must acquire this same root lock in later tickets.
  // Checking deletion after waiting prevents a save from reviving an archived form.
  const result = await client.query(
    "SELECT id FROM forms WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE",
    [formId, ownerId],
  );
  if (!result.rowCount)
    throw new HttpError(404, "NOT_FOUND", "Form not found.");
}
export function createDraft(pool: Pool, ownerId: string) {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string }>(
      "INSERT INTO forms (owner_id) VALUES ($1) RETURNING id",
      [ownerId],
    );
    const form = result.rows[0];
    if (!form) throw new Error("Form creation failed.");
    await client.query("INSERT INTO form_drafts (form_id) VALUES ($1)", [
      form.id,
    ]);
    return form;
  });
}
export function saveDraft(
  pool: Pool,
  ownerId: string,
  formId: string,
  definition: DraftDefinition,
  expectedETag: string | undefined,
) {
  return withTransaction(pool, async (client) => {
    await lockOwnedForm(client, formId, ownerId);
    if (!expectedETag || !/^"[a-f0-9]{64}"$/.test(expectedETag))
      throw new HttpError(
        428,
        "DRAFT_PRECONDITION_REQUIRED",
        "Load the draft before saving it.",
      );
    const stored = await client.query<{ definition: unknown }>(
      "SELECT definition FROM form_drafts WHERE form_id=$1",
      [formId],
    );
    const currentETag = draftETag(parseDraft(stored.rows[0]?.definition));
    if (currentETag !== expectedETag)
      throw new HttpError(
        409,
        "DRAFT_CHANGED",
        "This draft changed in another tab. Your edits are still here. Reload the saved draft before editing again.",
      );
    await client.query(
      "UPDATE form_drafts SET definition=$2,updated_at=clock_timestamp() WHERE form_id=$1",
      [formId, JSON.stringify(definition)],
    );
  });
}
export function archiveForm(pool: Pool, ownerId: string, formId: string) {
  return withTransaction(pool, async (client) => {
    await lockOwnedForm(client, formId, ownerId);
    await client.query(
      "UPDATE forms SET deleted_at=clock_timestamp(),is_published=false WHERE id=$1",
      [formId],
    );
  });
}
