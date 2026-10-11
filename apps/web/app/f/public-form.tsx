"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  parseSubmission,
  validateAnswers,
  SubmissionError,
} from "../../../api/src/contracts/submission";
import {
  parsePublicForm,
  type PublicForm,
} from "../../../api/src/contracts/draft";
import { ApiError, isRecord, requestApi } from "../api-client";
import { ResponseInput } from "./response-input";

export function PublicFormPage({ slug }: { slug: string }) {
  const [form, setForm] = useState<PublicForm | null>(null);
  const [email, setEmail] = useState("");
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState("");
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [stale, setStale] = useState(false);
  const [success, setSuccess] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    requestApi(`/public/forms/${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          if (!isRecord(result)) throw new Error("Could not read this form.");
          setForm(parsePublicForm(result.form));
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load this form.",
          );
          setUnavailable(failure instanceof ApiError && failure.status === 404);
        }
      });
    return () => controller.abort();
  }, [slug, attempt]);
  useEffect(() => {
    if (error || success) feedback.current?.focus();
  }, [error, success]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || inFlight.current || stale || unavailable || success) return;
    setError("");
    setErrorField("");
    inFlight.current = true;
    setBusy(true);
    try {
      const submission = parseSubmission({
        formVersionId: form.formVersionId,
        email,
        answers: form.questions.map((question) => {
          const value = values[question.id] ?? null;
          return {
            questionId: question.id,
            value:
              question.type === "linear_scale" &&
              typeof value === "string" &&
              value.trim()
                ? Number(value)
                : value,
          };
        }),
      });
      validateAnswers(form, submission);
      await requestApi(`/public/forms/${encodeURIComponent(slug)}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission),
      });
      setSuccess(true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not submit your answers.",
      );
      if (failure instanceof SubmissionError || failure instanceof ApiError)
        setErrorField(failure.field ?? "");
      if (failure instanceof ApiError) {
        setStale(failure.code === "FORM_UPDATED");
        setUnavailable(failure.status === 404);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (success)
    return (
      <main className="public-form">
        <div ref={feedback} tabIndex={-1} role="status">
          <h1>Thank you!</h1>
          <p>Your response has been submitted.</p>
        </div>
      </main>
    );
  return (
    <main className="public-form">
      <h1>{form?.title ?? "Public form"}</h1>
      {form?.description && (
        <p className="form-description">{form.description}</p>
      )}
      {error && (
        <div ref={feedback} tabIndex={-1} role="alert" className="error notice">
          <p>{error}</p>
          {stale && (
            <>
              <p>
                Your answers have not been saved. They remain below so you can
                review or copy them. Refreshing clears these entries.
              </p>
              <button type="button" onClick={() => window.location.reload()}>
                Refresh form
              </button>
            </>
          )}
          {unavailable && form && (
            <p>
              Your answers have not been saved. This form is no longer accepting
              responses.
            </p>
          )}
          {!form && !unavailable && (
            <button
              type="button"
              onClick={() => {
                setError("");
                setAttempt((value) => value + 1);
              }}
            >
              Retry loading
            </button>
          )}
        </div>
      )}
      {!form && !error && <p role="status">Loading form…</p>}
      {form && (
        <form onSubmit={submit} noValidate>
          <p>Fields marked * are required.</p>
          <fieldset className="editor-fields" disabled={busy}>
            <label htmlFor="respondent-email">
              Email address *
              <input
                id="respondent-email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={errorField === "email"}
                aria-describedby={
                  errorField === "email" ? "email-error" : undefined
                }
              />
            </label>
            {errorField === "email" && (
              <p className="error" id="email-error">
                {error}
              </p>
            )}
            {form.questions.map((question, position) => (
              <fieldset className="question-card" key={question.id}>
                <legend>
                  {position + 1}. {question.label}
                  {question.required ? " *" : ""}
                </legend>
                <ResponseInput
                  question={question}
                  value={values[question.id] ?? ""}
                  error={errorField === question.id ? error : ""}
                  onChange={(value) =>
                    setValues((previous) => ({
                      ...previous,
                      [question.id]: value,
                    }))
                  }
                />
                {errorField === question.id && (
                  <p className="error" id={`error-${question.id}`}>
                    {error}
                  </p>
                )}
              </fieldset>
            ))}
            <button type="submit" disabled={busy || stale || unavailable}>
              {busy ? "Submitting…" : "Submit response"}
            </button>
          </fieldset>
          <p className="hint">
            If a connection fails after you submit, we may have received your
            response. Retrying can create another response.
          </p>
        </form>
      )}
    </main>
  );
}
