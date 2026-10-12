import type { Pool } from "pg";
import { withTransaction } from "./database.js";
import { lockOwnedForm } from "./form-drafts.js";
import { HttpError } from "./errors.js";
import { assertWebhookDestination } from "./webhook-policy.js";

export type WebhookConfig = { url: string; secret: string };
export type WebhookJob = WebhookConfig & {
  responseId: string;
  payload: unknown;
};
export const webhookTimeoutMs = 5000;
const pendingDeliveries = new WeakMap<Pool, Set<Promise<void>>>();

export function parseWebhook(input: unknown): { url: string; secret?: string } {
  if (
    !input ||
    typeof input !== "object" ||
    !("url" in input) ||
    typeof input.url !== "string"
  )
    throw new HttpError(
      400,
      "INVALID_WEBHOOK",
      "Enter an HTTP or HTTPS webhook URL.",
    );
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new HttpError(400, "INVALID_WEBHOOK", "Enter a valid webhook URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    input.url.length > 2048
  )
    throw new HttpError(
      400,
      "INVALID_WEBHOOK",
      "Use HTTP or HTTPS without credentials or a fragment.",
    );
  assertWebhookDestination(url);
  const secret = "secret" in input ? input.secret : undefined;
  if (
    secret !== undefined &&
    (typeof secret !== "string" || !/^[\x21-\x7e]{1,512}$/.test(secret))
  )
    throw new HttpError(
      400,
      "INVALID_WEBHOOK",
      "Use 1–512 visible ASCII characters for the secret, without spaces.",
    );
  return { url: url.href, ...(typeof secret === "string" ? { secret } : {}) };
}

export function saveWebhook(
  pool: Pool,
  ownerId: string,
  formId: string,
  settings: ReturnType<typeof parseWebhook>,
) {
  return withTransaction(pool, async (client) => {
    await lockOwnedForm(client, formId, ownerId);
    const existing = await client.query<WebhookConfig>(
      "SELECT url,secret FROM form_webhooks WHERE form_id=$1",
      [formId],
    );
    const secret = settings.secret ?? existing.rows[0]?.secret;
    if (!secret)
      throw new HttpError(
        400,
        "INVALID_WEBHOOK",
        "A secret is required when configuring a webhook.",
      );
    await client.query(
      "INSERT INTO form_webhooks(form_id,url,secret) VALUES($1,$2,$3) ON CONFLICT(form_id) DO UPDATE SET url=EXCLUDED.url,secret=EXCLUDED.secret,updated_at=clock_timestamp()",
      [formId, settings.url, secret],
    );
  });
}
export function removeWebhook(pool: Pool, ownerId: string, formId: string) {
  return withTransaction(pool, async (client) => {
    await lockOwnedForm(client, formId, ownerId);
    await client.query("DELETE FROM form_webhooks WHERE form_id=$1", [formId]);
  });
}
export async function readWebhook(pool: Pool, ownerId: string, formId: string) {
  const result = await pool.query(
    `SELECT w.url,(w.form_id IS NOT NULL) AS "hasSecret",
    COALESCE((SELECT jsonb_agg(to_jsonb(attempt) ORDER BY attempt."startedAt" DESC,attempt.id DESC) FROM (
      SELECT a.id,a.response_id AS "responseId",a.destination_url AS url,a.started_at AS "startedAt",a.completed_at AS "completedAt",a.status_code AS "statusCode",a.error_message AS "errorMessage"
      FROM webhook_attempts a JOIN responses r ON r.id=a.response_id JOIN form_versions v ON v.id=r.form_version_id
      WHERE v.form_id=f.id ORDER BY a.started_at DESC,a.id DESC LIMIT 50
    ) attempt),'[]'::jsonb) AS attempts
    FROM forms f LEFT JOIN form_webhooks w ON w.form_id=f.id WHERE f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`,
    [formId, ownerId],
  );
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Form not found.");
  return result.rows[0];
}

async function deliverWebhook(pool: Pool, job: WebhookJob) {
  // Persist an attempt before HTTP, but never hold a DB client during the request.
  const inserted = await pool.query<{ id: string }>(
    "INSERT INTO webhook_attempts(response_id,destination_url,started_at) VALUES($1,$2,clock_timestamp()) RETURNING id",
    [job.responseId, job.url],
  );
  const attempt = inserted.rows[0];
  if (!attempt) throw new Error("Could not record webhook attempt.");
  let status: number | null = null;
  let error: string | null = null;
  const timeout = AbortSignal.timeout(webhookTimeoutMs);
  try {
    // Recheck persisted configurations too, including seeds and policy changes.
    assertWebhookDestination(new URL(job.url));
    const result = await fetch(job.url, {
      method: "POST",
      redirect: "manual",
      signal: timeout,
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": job.secret,
      },
      body: JSON.stringify(job.payload),
    });
    status = result.status;
    if (!result.ok) error = `Receiver returned HTTP ${result.status}.`;
    // Neither read nor log arbitrary receiver bodies, and never follow redirects
    // carrying a secret to another destination.
    await result.body?.cancel();
  } catch (failure) {
    if (
      failure instanceof HttpError &&
      failure.code === "WEBHOOK_DESTINATION_BLOCKED"
    )
      error = "Webhook destination is blocked by server policy.";
    else if (timeout.aborted) error = "Delivery timed out.";
    else error = "Could not connect to webhook receiver.";
  }
  await pool.query(
    "UPDATE webhook_attempts SET completed_at=clock_timestamp(),status_code=$2,error_message=$3 WHERE id=$1",
    [attempt.id, status, error],
  );
}

export function scheduleWebhook(pool: Pool, job: WebhookJob | null) {
  if (!job) return;
  let pending = pendingDeliveries.get(pool);
  if (!pending) {
    pending = new Set();
    pendingDeliveries.set(pool, pending);
  }
  const deliveries = pending;
  // Scheduling happens only after the response transaction committed and HTTP
  // success was sent. All failures are contained, including failure to log.
  const task = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => deliverWebhook(pool, job))
    .catch(() => {
      console.error("Webhook delivery or attempt logging failed.");
    });
  deliveries.add(task);
  void task.finally(() => deliveries.delete(task));
}
export async function drainWebhooks(pool: Pool) {
  await Promise.all(pendingDeliveries.get(pool) ?? []);
}
