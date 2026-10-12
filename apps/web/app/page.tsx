"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAccount } from "./account-shell";

export default function HomePage() {
  const router = useRouter();
  const session = useAccount();
  useEffect(() => {
    if (session.user) router.replace("/forms");
  }, [session.user, router]);
  return (
    <main className="home-menu">
      <h1>Forms App</h1>
      {session.loading || session.user ? (
        <p role="status">Opening your account…</p>
      ) : session.error ? (
        <div role="alert" className="error">
          <p>{session.error}</p>
          <button onClick={session.retry}>Try again</button>
        </div>
      ) : (
        <nav className="home-menu-links" aria-label="Get started">
          <Link href="/login">
            <strong>Sign in</strong>
            <span>Open your forms and responses</span>
          </Link>
          <Link href="/register">
            <strong>Create account</strong>
            <span>Start building your first form</span>
          </Link>
        </nav>
      )}
    </main>
  );
}
