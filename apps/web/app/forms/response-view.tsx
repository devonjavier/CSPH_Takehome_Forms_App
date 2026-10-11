"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, requestApi } from "../api-client";
import {
  readResponseDetail,
  readResponseListing,
  type ResponseDetail,
  type ResponseListing,
} from "./response-contract";

export function ResponseView({
  formId,
  responseId,
}: {
  formId: string;
  responseId?: string;
}) {
  const router = useRouter();
  const [listing, setListing] = useState<ResponseListing | null>(null);
  const [detail, setDetail] = useState<ResponseDetail | null>(null);
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const path = responseId
      ? `/forms/${formId}/responses/${responseId}`
      : `/forms/${formId}/responses?page=${page}`;
    requestApi(path, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (responseId) setDetail(readResponseDetail(result));
        else setListing(readResponseListing(result));
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) {
          router.replace("/login");
          return;
        }
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load responses.",
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [formId, responseId, page, attempt, router]);
  function reload(nextPage = page) {
    setLoading(true);
    setError("");
    setListing(null);
    setDetail(null);
    setPage(nextPage);
    setAttempt((value) => value + 1);
  }
  return (
    <main className="response-page">
      <nav className="actions" aria-label="Response navigation">
        <Link href="/forms">Your forms</Link>
        <Link href={`/forms/${formId}`}>Edit form</Link>
        {responseId && (
          <Link href={`/forms/${formId}/responses`}>All responses</Link>
        )}
      </nav>
      <h1>{responseId ? "Response detail" : "Responses"}</h1>
      {loading && <p role="status">Loading responses…</p>}
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <button onClick={() => reload()}>Try again</button>
        </div>
      )}
      {!loading && !error && listing && (
        <>
          <h2>{listing.form.title}</h2>
          <p>
            {listing.total} {listing.total === 1 ? "response" : "responses"}
          </p>
          <button onClick={() => reload(0)}>Refresh responses</button>
          {listing.total === 0 ? (
            <p className="notice">No responses yet.</p>
          ) : (
            <>
              {listing.responses.length === 0 ? (
                <p>No responses on this page.</p>
              ) : (
                <div
                  className="response-table-scroll"
                  role="region"
                  aria-label="Responses table"
                  tabIndex={0}
                >
                  <table className="response-table">
                    <caption>Submissions, newest first</caption>
                    <thead>
                      <tr>
                        <th scope="col">Email</th>
                        <th scope="col">Submitted</th>
                        <th scope="col">Version</th>
                        <th scope="col">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listing.responses.map((response) => (
                        <tr key={response.id}>
                          <td>{response.email}</td>
                          <td>
                            <time dateTime={response.submittedAt}>
                              {new Date(response.submittedAt).toLocaleString()}
                            </time>
                          </td>
                          <td>{response.versionNumber}</td>
                          <td>
                            <Link
                              href={`/forms/${formId}/responses/${response.id}`}
                            >
                              View response
                              <span className="visually-hidden">
                                {" "}
                                from {response.email}, version{" "}
                                {response.versionNumber}
                              </span>
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="actions">
                <button disabled={page === 0} onClick={() => reload(page - 1)}>
                  Previous
                </button>
                <span>
                  Page {page + 1} of{" "}
                  {Math.max(1, Math.ceil(listing.total / listing.pageSize))}
                </span>
                <button
                  disabled={(page + 1) * listing.pageSize >= listing.total}
                  onClick={() => reload(page + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </>
      )}
      {!loading && !error && detail && (
        <>
          <h2>{detail.title}</h2>
          <p>
            Version {detail.versionNumber} · {detail.email}
          </p>
          <p>
            Submitted{" "}
            <time dateTime={detail.submittedAt}>
              {new Date(detail.submittedAt).toLocaleString()}
            </time>
          </p>
          {detail.description && (
            <p className="response-text">{detail.description}</p>
          )}
          <p className="hint">
            Questions and choices below are from the version answered.
          </p>
          {detail.answers.map((answer, index) => (
            <section className="question-card" key={answer.questionId}>
              <h3>
                {index + 1}. {answer.label}
              </h3>
              {answer.selectedOptions.length ? (
                <ul>
                  {answer.selectedOptions.map((option) => (
                    <li className="response-text" key={option.id}>
                      {option.label}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="response-text">
                  {answer.value ?? "Not answered"}
                </p>
              )}
            </section>
          ))}
        </>
      )}
    </main>
  );
}
