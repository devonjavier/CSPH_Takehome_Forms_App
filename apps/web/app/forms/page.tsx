"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, isRecord, requestApi } from "../api-client";

type FormSummary = { id: string; title: string; isPublished: boolean };
type Account = { forms: FormSummary[] };

function readAccount(listing: unknown): Account {
  if (!isRecord(listing) || !Array.isArray(listing.forms))
    throw new Error("Could not load your account. Please try again.");
  const forms = listing.forms.map((form: unknown): FormSummary => {
    if (
      !isRecord(form) ||
      typeof form.id !== "string" ||
      typeof form.title !== "string" ||
      typeof form.isPublished !== "boolean"
    )
      throw new Error("Could not load your forms. Please try again.");
    return { id: form.id, title: form.title, isPublished: form.isPublished };
  });
  return { forms };
}

export default function FormsPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  async function createForm() {
    setCreating(true);
    setError("");
    try {
      const result = await requestApi("/forms", { method: "POST" });
      if (
        !isRecord(result) ||
        !isRecord(result.form) ||
        typeof result.form.id !== "string"
      )
        throw new Error("Could not create the form.");
      router.push(`/forms/${result.form.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not create the form.",
      );
      setCreating(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    requestApi("/forms", { signal: controller.signal })
      .then((listing) => {
        if (!controller.signal.aborted) setAccount(readAccount(listing));
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) {
          router.replace("/login");
          return;
        }
        setError(
          failure instanceof Error ? failure.message : "Please try again.",
        );
      });
    return () => controller.abort();
  }, [router, attempt]);

  return (
    <main className="dashboard">
      <h1>Your forms</h1>
      {error && (
        <div role="alert" className="error">
          <p>{error}</p>
          {!account && (
            <button
              onClick={() => {
                setError("");
                setAttempt(attempt + 1);
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {!account && !error && <p role="status">Loading your account…</p>}
      {account && (
        <>
          <button disabled={creating} onClick={createForm}>
            {creating ? "Creating…" : "Create form"}
          </button>
          {account.forms.length === 0 ? (
            <p className="notice">You don’t have any forms yet.</p>
          ) : (
            <ul className="form-list">
              {account.forms.map((form) => (
                <li key={form.id}>
                  <h2>
                    <Link href={`/forms/${form.id}`}>{form.title}</Link>
                  </h2>
                  <span className="status-badge">
                    {form.isPublished ? "Published" : "Offline"}
                  </span>
                  <nav
                    className="form-menu"
                    aria-label={`Actions for ${form.title}`}
                  >
                    <Link href={`/forms/${form.id}`}>Edit form</Link>
                    <Link href={`/forms/${form.id}/responses`}>
                      View responses
                    </Link>
                    <Link href={`/forms/${form.id}/webhook`}>Webhook</Link>
                  </nav>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
