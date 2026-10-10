"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  changeQuestionType,
  isQuestionType,
  parseDraft,
  questionTypes,
  type DraftDefinition,
  type DraftQuestion,
  type QuestionType,
} from "../../../api/src/contracts/draft";
import { ApiError, isRecord, requestApi } from "../api-client";

const typeLabels: Record<QuestionType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  date: "Date",
  dropdown: "Dropdown",
  multi_select: "Multiple-select dropdown",
  multiple_choice: "Multiple choice",
  checkboxes: "Checkboxes",
  linear_scale: "Linear scale",
};
function move<T>(values: T[], index: number, direction: number): T[] {
  const copy = [...values];
  const entry = copy[index];
  if (
    entry === undefined ||
    index + direction < 0 ||
    index + direction >= copy.length
  )
    return values;
  copy.splice(index, 1);
  copy.splice(index + direction, 0, entry);
  return copy;
}
export function DraftEditor({ formId }: { formId: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftDefinition | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dirty = draft !== null && JSON.stringify(draft) !== saved;
  useEffect(() => {
    const controller = new AbortController();
    requestApi(`/forms/${formId}/draft`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!isRecord(result)) throw new Error("Could not load the draft.");
        const definition = parseDraft(result.definition);
        setDraft(definition);
        setSaved(JSON.stringify(definition));
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401)
          router.replace("/login");
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load the draft.",
          );
      });
    return () => controller.abort();
  }, [formId, router, attempt]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function updateQuestion(id: string, next: DraftQuestion) {
    if (draft)
      setDraft({
        ...draft,
        questions: draft.questions.map((question) =>
          question.id === id ? next : question,
        ),
      });
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const definition = parseDraft(draft);
      await requestApi(`/forms/${formId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(definition),
      });
      setDraft(definition);
      setSaved(JSON.stringify(definition));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    setBusy(true);
    setError("");
    try {
      await requestApi(`/forms/${formId}`, { method: "DELETE" });
      router.replace("/forms");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not archive. Please try again.",
      );
      setBusy(false);
    }
  }
  return (
    <main className="builder">
      <Link
        href="/forms"
        onClick={(event) => {
          if (
            dirty &&
            !window.confirm("Leave without saving your draft changes?")
          )
            event.preventDefault();
        }}
      >
        Your forms
      </Link>
      <h1>Edit draft</h1>
      <p>
        Save changes here without changing the published form. Incomplete drafts
        can be saved.
      </p>
      {error && (
        <div role="alert" className="error">
          <p>{error}</p>
          {!draft && (
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
      {!draft && !error && <p role="status">Loading draft…</p>}
      {draft && (
        <>
          <p role="status">
            {busy ? "Please wait…" : dirty ? "Unsaved changes" : "Draft saved"}
          </p>
          <fieldset disabled={busy} className="editor-fields">
            <label>
              Form title
              <input
                value={draft.title}
                maxLength={500}
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
              />
            </label>
            <label>
              Description
              <textarea
                value={draft.description ?? ""}
                maxLength={10000}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </label>
            <p>
              Respondent email is collected separately when someone fills out
              the published form.
            </p>
            {draft.questions.map((question, index) => (
              <fieldset className="question-card" key={question.id}>
                <legend>Question {index + 1}</legend>
                <label>
                  Question label
                  <input
                    value={question.label}
                    maxLength={1000}
                    onChange={(event) =>
                      updateQuestion(question.id, {
                        ...question,
                        label: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Question type
                  <select
                    value={question.type}
                    onChange={(event) => {
                      const type = event.target.value;
                      if (isQuestionType(type))
                        updateQuestion(
                          question.id,
                          changeQuestionType(question, type),
                        );
                    }}
                  >
                    {questionTypes.map((type) => (
                      <option key={type} value={type}>
                        {typeLabels[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="hint">
                  Changing the type clears its options and scale settings.
                </p>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={question.required}
                    onChange={(event) =>
                      updateQuestion(question.id, {
                        ...question,
                        required: event.target.checked,
                      })
                    }
                  />
                  Required
                </label>
                {"options" in question && (
                  <div className="option-editor">
                    <p>Options may be incomplete while drafting.</p>
                    {question.options.map((option, optionIndex) => (
                      <div className="option-row" key={option.id}>
                        <label>
                          Option {optionIndex + 1}
                          <input
                            value={option.label}
                            maxLength={1000}
                            onChange={(event) =>
                              updateQuestion(question.id, {
                                ...question,
                                options: question.options.map((existing) =>
                                  existing.id === option.id
                                    ? { ...existing, label: event.target.value }
                                    : existing,
                                ),
                              })
                            }
                          />
                        </label>
                        <div className="actions">
                          <button
                            type="button"
                            aria-label={`Move option ${optionIndex + 1} up`}
                            disabled={optionIndex === 0}
                            onClick={() =>
                              updateQuestion(question.id, {
                                ...question,
                                options: move(
                                  question.options,
                                  optionIndex,
                                  -1,
                                ),
                              })
                            }
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            aria-label={`Move option ${optionIndex + 1} down`}
                            disabled={
                              optionIndex === question.options.length - 1
                            }
                            onClick={() =>
                              updateQuestion(question.id, {
                                ...question,
                                options: move(question.options, optionIndex, 1),
                              })
                            }
                          >
                            Down
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove option ${optionIndex + 1}`}
                            onClick={() =>
                              updateQuestion(question.id, {
                                ...question,
                                options: question.options.filter(
                                  (existing) => existing.id !== option.id,
                                ),
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={question.options.length >= 100}
                      onClick={() =>
                        updateQuestion(question.id, {
                          ...question,
                          options: [
                            ...question.options,
                            { id: crypto.randomUUID(), label: "" },
                          ],
                        })
                      }
                    >
                      Add option
                    </button>
                  </div>
                )}
                {question.type === "linear_scale" && (
                  <div className="scale-editor">
                    <label>
                      Minimum
                      <input
                        type="number"
                        step="1"
                        value={question.min ?? ""}
                        onChange={(event) =>
                          updateQuestion(question.id, {
                            ...question,
                            min:
                              event.target.value === ""
                                ? null
                                : event.target.valueAsNumber,
                          })
                        }
                      />
                    </label>
                    <label>
                      Maximum
                      <input
                        type="number"
                        step="1"
                        value={question.max ?? ""}
                        onChange={(event) =>
                          updateQuestion(question.id, {
                            ...question,
                            max:
                              event.target.value === ""
                                ? null
                                : event.target.valueAsNumber,
                          })
                        }
                      />
                    </label>
                    <label>
                      Minimum label
                      <input
                        maxLength={1000}
                        value={question.minLabel}
                        onChange={(event) =>
                          updateQuestion(question.id, {
                            ...question,
                            minLabel: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Maximum label
                      <input
                        maxLength={1000}
                        value={question.maxLabel}
                        onChange={(event) =>
                          updateQuestion(question.id, {
                            ...question,
                            maxLabel: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                <div className="actions">
                  <button
                    type="button"
                    aria-label={`Move question ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        questions: move(draft.questions, index, -1),
                      })
                    }
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    aria-label={`Move question ${index + 1} down`}
                    disabled={index === draft.questions.length - 1}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        questions: move(draft.questions, index, 1),
                      })
                    }
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        questions: draft.questions.filter(
                          (existing) => existing.id !== question.id,
                        ),
                      })
                    }
                  >
                    Remove question
                  </button>
                </div>
              </fieldset>
            ))}
            {draft.questions.length === 0 && (
              <p>No questions yet. Add one to start building.</p>
            )}
            <div className="actions">
              <button
                type="button"
                disabled={draft.questions.length >= 100}
                onClick={() =>
                  setDraft({
                    ...draft,
                    questions: [
                      ...draft.questions,
                      {
                        id: crypto.randomUUID(),
                        type: "short_text",
                        label: "",
                        required: false,
                      },
                    ],
                  })
                }
              >
                Add question
              </button>
              <button type="button" onClick={save}>
                Save draft
              </button>
            </div>
          </fieldset>
          <section className="archive-panel">
            <h2>Archive form</h2>
            <p>
              Archiving removes access to this form and its responses, including
              any public link. Stored history is retained. There is no restore
              feature.
            </p>
            {confirmArchive ? (
              <div className="actions">
                <button disabled={busy} onClick={archive}>
                  Confirm archive
                </button>
                <button
                  disabled={busy}
                  onClick={() => setConfirmArchive(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button disabled={busy} onClick={() => setConfirmArchive(true)}>
                Archive form
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
