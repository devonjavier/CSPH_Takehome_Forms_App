"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError, isRecord, requestApi } from "../api-client";

type Attempt = {
  id: string;
  responseId: string;
  url: string;
  startedAt: string;
  completedAt: string | null;
  statusCode: number | null;
  errorMessage: string | null;
};
type Settings = { url: string | null; hasSecret: boolean; attempts: Attempt[] };
function parseSettings(value: unknown): Settings {
  if (!isRecord(value) || !isRecord(value.webhook))
    throw new Error("Could not read webhook settings.");
  const hook = value.webhook;
  if (
    (hook.url !== null && typeof hook.url !== "string") ||
    typeof hook.hasSecret !== "boolean" ||
    !Array.isArray(hook.attempts)
  )
    throw new Error("Could not read webhook settings.");
  const attempts = hook.attempts.map((attempt: unknown): Attempt => {
    if (
      !isRecord(attempt) ||
      typeof attempt.id !== "string" ||
      typeof attempt.responseId !== "string" ||
      typeof attempt.url !== "string" ||
      typeof attempt.startedAt !== "string" ||
      (attempt.completedAt !== null &&
        typeof attempt.completedAt !== "string") ||
      (attempt.statusCode !== null && typeof attempt.statusCode !== "number") ||
      (attempt.errorMessage !== null &&
        typeof attempt.errorMessage !== "string")
    )
      throw new Error("Could not read delivery logs.");
    return {
      id: attempt.id,
      responseId: attempt.responseId,
      url: attempt.url,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      statusCode: attempt.statusCode,
      errorMessage: attempt.errorMessage,
    };
  });
  return { url: hook.url, hasSecret: hook.hasSecret, attempts };
}
export function WebhookSettings({ formId }: { formId: string }) {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const path = `/forms/${formId}/webhook`;
  function handleFailure(failure: unknown) {
    if (failure instanceof ApiError && failure.status === 401) {
      router.replace("/login");
      return;
    }
    setError(failure instanceof Error ? failure.message : "Request failed.");
  }
  useEffect(() => {
    const controller = new AbortController();
    requestApi(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setSettings(parseSettings(result));
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401)
          router.replace("/login");
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load webhook.",
          );
      });
    return () => controller.abort();
  }, [path, refresh, router]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const form = event.currentTarget;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const secret = fields.get("secret");
      await requestApi(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: fields.get("url"),
          ...(secret ? { secret } : {}),
        }),
      });
      form.reset();
      setSettings(null);
      setRefresh((value) => value + 1);
      setMessage("Webhook saved.");
    } catch (failure) {
      handleFailure(failure);
    } finally {
      setPending(false);
    }
  }
  async function disable() {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await requestApi(path, { method: "DELETE" });
      setSettings(null);
      setRefresh((value) => value + 1);
      setMessage("Webhook disabled. Existing logs are retained.");
    } catch (failure) {
      handleFailure(failure);
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="response-page">
      <nav className="actions">
        <Link href="/forms">Your forms</Link>
        <Link href={`/forms/${formId}/responses`}>Responses</Link>
      </nav>
      <h1>Webhook</h1>
      <p>
        Send each new submission to your receiver after it is saved. Delivery
        has a five-second timeout and no retries.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <button
        disabled={pending}
        onClick={() => {
          setError("");
          setSettings(null);
          setRefresh((value) => value + 1);
        }}
      >
        Refresh settings and logs
      </button>
      {!settings && !error && <p role="status">Loading webhook…</p>}
      {settings && (
        <>
          <form className="account-form" onSubmit={save} key={refresh}>
            <label htmlFor="webhook-url">Receiver URL</label>
            <input
              id="webhook-url"
              name="url"
              type="url"
              required
              maxLength={2048}
              defaultValue={settings.url ?? ""}
              disabled={pending}
            />
            <label htmlFor="webhook-secret">
              {settings.hasSecret ? "Replacement secret (optional)" : "Secret"}
            </label>
            <input
              id="webhook-secret"
              name="secret"
              type="password"
              autoComplete="new-password"
              required={!settings.hasSecret}
              maxLength={512}
              disabled={pending}
              aria-describedby="secret-help"
            />
            <p id="secret-help" className="hint">
              Use visible ASCII characters without spaces.{" "}
              {settings.hasSecret &&
                "A secret is configured. Leave blank to keep it; it is never displayed."}
            </p>
            <button disabled={pending}>
              {pending ? "Saving…" : "Save webhook"}
            </button>
          </form>
          {settings.hasSecret && (
            <button disabled={pending} onClick={disable}>
              Disable webhook
            </button>
          )}
          <h2>Latest 50 delivery attempts</h2>
          <p className="hint">
            Refresh to see completed deliveries. Disabling or changing settings
            affects future submissions.
          </p>
          {!settings.attempts.length && <p>No delivery attempts yet.</p>}
          {settings.attempts.map((attempt) => (
            <section className="question-card" key={attempt.id}>
              <p>
                <time dateTime={attempt.startedAt}>
                  {new Date(attempt.startedAt).toLocaleString()}
                </time>
              </p>
              <p>{attempt.url}</p>
              <p>
                {attempt.completedAt === null
                  ? "Pending (or interrupted before completion)"
                  : (attempt.errorMessage ?? "Delivered")}
                {attempt.statusCode !== null && ` · HTTP ${attempt.statusCode}`}
              </p>
              <Link href={`/forms/${formId}/responses/${attempt.responseId}`}>
                View response
              </Link>
            </section>
          ))}
        </>
      )}
    </main>
  );
}
