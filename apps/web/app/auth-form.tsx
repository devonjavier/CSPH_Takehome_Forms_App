"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { requestApi } from "./api-client";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const registering = mode === "register";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      await requestApi(`/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: fields.get("email"),
          password: fields.get("password"),
        }),
      });
      router.replace("/forms");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Please try again.",
      );
      setPending(false);
    }
  }

  return (
    <main className="account-page">
      <Link className="brand" href="/">
        Forms App
      </Link>
      <h1>{registering ? "Create your account" : "Welcome back"}</h1>
      <p>
        {registering
          ? "Keep your forms and responses in one place."
          : "Sign in to view your forms."}
      </p>
      <form onSubmit={submit} aria-busy={pending} className="account-form">
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          disabled={pending}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={registering ? "new-password" : "current-password"}
          required
          minLength={12}
          maxLength={128}
          aria-describedby="password-help"
          disabled={pending}
        />
        <small id="password-help">Use 12–128 characters.</small>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button disabled={pending} type="submit">
          {pending
            ? "Please wait…"
            : registering
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
      <p>
        {registering ? "Already have an account? " : "New here? "}
        <Link href={registering ? "/login" : "/register"}>
          {registering ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </main>
  );
}
