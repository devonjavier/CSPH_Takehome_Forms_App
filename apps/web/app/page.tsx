export default function HomePage() {
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
import Link from "next/link";
