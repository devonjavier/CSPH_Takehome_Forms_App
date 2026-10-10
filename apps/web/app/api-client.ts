export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function requestApi(
  path: string,
  options?: RequestInit,
): Promise<unknown> {
  let response: Response;
  // Network loss does not always reject fetch immediately (e.g. a stalled TCP
  // connection). Bound both headers and body reading so the form can be retried.
  const timeout = AbortSignal.timeout(10000);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let body: unknown;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (response.status === 204) return null;
    body = await response.json();
  } catch {
    if (options?.signal?.aborted) throw new Error("Request cancelled.");
    if (timeout.aborted)
      throw new Error("The request timed out. Please try again.");
    throw new Error("Could not reach the server. Please try again.");
  }
  if (!response.ok) {
    let message = "Something went wrong. Please try again.";
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
    )
      message = body.error.message;
    throw new ApiError(response.status, message);
  }
  return body;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
