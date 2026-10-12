"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ApiError, isRecord, requestApi } from "./api-client";

type Account = { email: string };
type Session = {
  user: Account | null;
  loading: boolean;
  error: string;
  retry: () => void;
};
const AccountContext = createContext<Session | null>(null);

export function useAccount(): Session {
  const session = useContext(AccountContext);
  if (!session) throw new Error("Account context is unavailable.");
  return session;
}

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Public respondents never trigger an owner profile request or see owner navigation.
  if (pathname.startsWith("/f/")) return children;
  return <AccountLayout pathname={pathname}>{children}</AccountLayout>;
}

function AccountLayout({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [result, setResult] = useState<{
    path: string;
    user: Account | null;
    error: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    requestApi("/auth/me", { signal: controller.signal })
      .then((profile) => {
        if (
          !isRecord(profile) ||
          !isRecord(profile.user) ||
          typeof profile.user.email !== "string"
        )
          throw new Error("Could not read your account.");
        if (!controller.signal.aborted)
          setResult({
            path: pathname,
            user: { email: profile.user.email },
            error: "",
          });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        const signedOut = failure instanceof ApiError && failure.status === 401;
        setResult({
          path: pathname,
          user: null,
          error: signedOut ? "" : "Could not check your account. Please retry.",
        });
      });
    return () => controller.abort();
  }, [pathname, attempt]);
  const loading = result?.path !== pathname;
  const session: Session = {
    user: loading ? null : result.user,
    loading,
    error: loading ? "" : result.error,
    retry: () => setAttempt((value) => value + 1),
  };
  async function signOut() {
    setSigningOut(true);
    setLogoutError("");
    try {
      await requestApi("/auth/logout", { method: "POST" });
      setResult({ path: pathname, user: null, error: "" });
      router.replace("/login");
    } catch {
      setLogoutError("Could not sign out. Please retry.");
    } finally {
      setSigningOut(false);
    }
  }
  return (
    <AccountContext.Provider value={session}>
      <header className="site-header">
        <Link className="brand" href="/">
          Forms App
        </Link>
        <nav aria-label="Account navigation" className="account-menu">
          {session.loading ? (
            <span role="status">Checking account…</span>
          ) : session.user ? (
            <>
              <Link href="/forms">Your forms</Link>
              <span className="account-identity">
                <small>Signed in as</small>
                {session.user.email}
              </span>
              <button onClick={signOut} disabled={signingOut}>
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </>
          ) : session.error ? (
            <>
              <span role="status">Account unavailable</span>
              <button onClick={session.retry}>Retry</button>
            </>
          ) : (
            <>
              <Link href="/login">Sign in</Link>
              <Link href="/register">Create account</Link>
            </>
          )}
          {logoutError && (
            <span role="alert" className="error">
              {logoutError}
            </span>
          )}
        </nav>
      </header>
      {children}
    </AccountContext.Provider>
  );
}
