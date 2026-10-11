"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DraftDefinition } from "../../../api/src/contracts/draft";
import { ApiError, isRecord, requestApi } from "../api-client";

type PublicationState = {
  slug: string;
  isPublished: boolean;
  versionNumber: number | null;
};
type PendingPublication = {
  publicationActionId: string;
  definition: DraftDefinition;
};

function readPublication(result: unknown): PublicationState {
  if (!isRecord(result) || !isRecord(result.publication))
    throw new Error("Could not load publication status.");
  const publication = result.publication;
  if (
    typeof publication.slug !== "string" ||
    typeof publication.isPublished !== "boolean" ||
    !(
      publication.versionNumber === null ||
      typeof publication.versionNumber === "number"
    )
  )
    throw new Error("Could not load publication status.");
  return {
    slug: publication.slug,
    isPublished: publication.isPublished,
    versionNumber: publication.versionNumber,
  };
}

export function PublicationControls({
  formId,
  definition,
  hasUnsavedChanges,
  busy,
  onBusyChange,
}: {
  formId: string;
  definition: DraftDefinition;
  hasUnsavedChanges: boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [publication, setPublication] = useState<PublicationState | null>(null);
  const [confirmation, setConfirmation] = useState<
    "publish" | "unpublish" | null
  >(null);
  const [pending, setPending] = useState<PendingPublication | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const publicationHintId = useId();
  let publishDisabledReason = "";
  if (hasUnsavedChanges) {
    publishDisabledReason = "Save your draft changes before publishing.";
  } else if (busy) {
    publishDisabledReason = "Wait for the current operation to finish.";
  } else if (!publication) {
    publishDisabledReason = error
      ? "Refresh publication status before publishing."
      : "Wait for publication status to load.";
  }
  useEffect(() => {
    const controller = new AbortController();
    requestApi(`/forms/${formId}/publication`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setPublication(readPublication(result));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load publication status.",
          );
      });
    return () => controller.abort();
  }, [formId, attempt]);

  async function publish(action: PendingPublication) {
    if (inFlight.current) return;
    inFlight.current = true;
    onBusyChange(true);
    setError("");
    setNotice("");
    setConfirmation(null);
    setPending(action);
    try {
      const result = await requestApi(`/forms/${formId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      if (
        !isRecord(result) ||
        !isRecord(result.publication) ||
        typeof result.publication.versionNumber !== "number"
      )
        throw new Error(
          "Could not confirm the publication result. Retry this action.",
        );
      setPending(null);
      setNotice(
        `Publication completed: version ${result.publication.versionNumber}.`,
      );
      setAttempt((value) => value + 1);
    } catch (failure) {
      // A timeout/5xx can happen after commit. Keep both the UUID and snapshot so
      // Retry asks about the same action instead of creating a second version.
      if (
        failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500
      )
        setPending(null);
      setError(
        failure instanceof Error
          ? failure.message
          : "Publication failed. Please retry.",
      );
    } finally {
      inFlight.current = false;
      onBusyChange(false);
    }
  }
  async function unpublish() {
    if (inFlight.current) return;
    inFlight.current = true;
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      await requestApi(`/forms/${formId}/unpublish`, { method: "POST" });
      setConfirmation(null);
      setNotice("Form unpublished. Your history is retained.");
      setAttempt((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not unpublish. Please retry.",
      );
    } finally {
      inFlight.current = false;
      onBusyChange(false);
    }
  }
  return (
    <section className="archive-panel" aria-label="Publication">
      <h2>Publication</h2>
      {publication ? (
        <>
          <p>
            {publication.isPublished
              ? `Published · version ${publication.versionNumber}`
              : publication.versionNumber
                ? `Offline · last published version ${publication.versionNumber}`
                : "Not published"}
          </p>
          <p>
            Public slug: <code>{publication.slug}</code>
          </p>
          {publication.isPublished && (
            <p>
              <a href={`/f/${publication.slug}`}>Open public form</a>
            </p>
          )}
        </>
      ) : (
        <p>Loading publication status…</p>
      )}
      {error && (
        <div role="alert" className="error">
          <p>{error}</p>
          <button
            disabled={busy}
            onClick={() => {
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            Refresh status
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {publishDisabledReason && (
        <p id={publicationHintId} role="status">
          {publishDisabledReason}
        </p>
      )}
      {pending ? (
        <>
          <p>
            The publication result is not confirmed. Retry checks the same
            action without creating another version. Keep this page open until
            it is resolved.
          </p>
          <button disabled={busy} onClick={() => publish(pending)}>
            Retry publication
          </button>
        </>
      ) : confirmation === "publish" ? (
        <>
          <p>
            Publish this saved draft as a new version? Every confirmed
            publication creates a new version, even with identical content.
            Previous responses keep their original questions.
          </p>
          <div className="actions">
            <button
              disabled={busy || hasUnsavedChanges}
              title={publishDisabledReason || undefined}
              aria-describedby={
                publishDisabledReason ? publicationHintId : undefined
              }
              onClick={() =>
                publish({
                  publicationActionId: crypto.randomUUID(),
                  definition,
                })
              }
            >
              Confirm publish
            </button>
            <button disabled={busy} onClick={() => setConfirmation(null)}>
              Cancel publication
            </button>
          </div>
        </>
      ) : confirmation === "unpublish" ? (
        <>
          <p>
            Take this form offline? Its public link will stop working. Stored
            versions and responses will remain available to you.
          </p>
          <div className="actions">
            <button disabled={busy} onClick={unpublish}>
              Confirm unpublish
            </button>
            <button disabled={busy} onClick={() => setConfirmation(null)}>
              Cancel unpublish
            </button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button
            aria-disabled={Boolean(publishDisabledReason)}
            aria-describedby={
              publishDisabledReason ? publicationHintId : undefined
            }
            title={publishDisabledReason || undefined}
            onClick={() => {
              if (publishDisabledReason) return;
              setNotice("");
              setConfirmation("publish");
            }}
          >
            Publish changes
          </button>
          {publication?.isPublished && (
            <button
              disabled={busy}
              onClick={() => setConfirmation("unpublish")}
            >
              Unpublish
            </button>
          )}
        </div>
      )}
    </section>
  );
}
