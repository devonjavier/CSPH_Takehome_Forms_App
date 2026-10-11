"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isRecord } from "../api-client";

export function ExportButton({ formId }: { formId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/forms/${formId}/responses/export`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(60000),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      if (!response.ok) {
        const body: unknown = await response.json();
        throw new Error(
          isRecord(body) &&
            isRecord(body.error) &&
            typeof body.error.message === "string"
            ? body.error.message
            : "Could not export responses.",
        );
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `form-${formId}-responses.xlsx`;
      document.body.append(link);
      link.click();
      link.remove();
      // Let the browser start consuming the object URL before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Download failed. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <button disabled={pending} onClick={download}>
        {pending ? "Preparing download…" : "Export XLSX"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
