import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AccountShell } from "./account-shell";

export const metadata: Metadata = {
  title: "Forms App",
  description: "Create forms and collect responses.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AccountShell>{children}</AccountShell>
      </body>
    </html>
  );
}
