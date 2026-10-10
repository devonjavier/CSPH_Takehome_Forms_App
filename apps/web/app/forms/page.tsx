"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, isRecord, requestApi } from "../api-client";

type FormSummary = { id: string; title: string; isPublished: boolean };
type Account = { email: string; forms: FormSummary[] };

function readAccount(profile: unknown, listing: unknown): Account {
  if (
    !isRecord(profile) ||
    !isRecord(profile.user) ||
    typeof profile.user.email !== "string" ||
    !isRecord(listing) ||
    !Array.isArray(listing.forms)
  )
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
  return { email: profile.user.email, forms };
}

export default function FormsPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      requestApi("/auth/me", { signal: controller.signal }),
      requestApi("/forms", { signal: controller.signal }),
    ])
      .then(([profile, listing]) => {
        if (!controller.signal.aborted)
          setAccount(readAccount(profile, listing));
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

  async function signOut() {
    setSigningOut(true);
    setError("");
    try {
      await requestApi("/auth/logout", { method: "POST" });
      router.replace("/login");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Please try again.",
      );
      setSigningOut(false);
    }
  }

  return (
    <main>
      <Link className="brand" href="/">
        Forms App
      </Link>
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
          <div className="account-bar">
            <p>Signed in as {account.email}</p>
            <button onClick={signOut} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
          {account.forms.length === 0 ? (
            <p className="notice">You don’t have any forms yet.</p>
          ) : (
            <ul className="form-list">
              {account.forms.map((form) => (
                <li key={form.id}>
                  <h2>{form.title}</h2>
                  <span>{form.isPublished ? "Published" : "Draft"}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
