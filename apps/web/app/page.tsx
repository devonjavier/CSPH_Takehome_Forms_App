"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, isRecord, requestApi } from "./api-client";

export default function HomePage() {
  const router = useRouter();
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // The API validates the HttpOnly cookie; cookie presence alone is not auth.
    requestApi("/auth/me", { signal: controller.signal })
      .then((profile) => {
        if (controller.signal.aborted) return;
        if (
          !isRecord(profile) ||
          !isRecord(profile.user) ||
          typeof profile.user.id !== "string"
        )
          throw new Error("Could not check your session. Please try again.");
        router.replace("/forms");
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) {
          setSignedOut(true);
          return;
        }
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not check your session.",
        );
      });
    return () => controller.abort();
  }, [router, attempt]);

  if (!signedOut) {
    return (
      <main>
        <p className="eyebrow">Forms App</p>
        {error ? (
          <div role="alert" className="error">
            <p>{error}</p>
            <button
              onClick={() => {
                setError("");
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <p role="status">Checking your session…</p>
        )}
      </main>
    );
  }
  return (
    <main>
      <p className="eyebrow">Forms App</p>
      <h1>A place for your questions.</h1>
      <p>Create forms, share a link, and keep responses organized.</p>
      <nav className="actions" aria-label="Account">
        <Link href="/login">Sign in</Link>
        <Link href="/register">Create an account</Link>
        <Link href="/forms">Your forms</Link>
      </nav>
    </main>
  );
}
