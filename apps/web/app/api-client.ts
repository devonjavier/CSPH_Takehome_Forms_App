export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export async function requestApi(
  path: string,
  options?: RequestInit,
): Promise<unknown> {
  // Let an immediately cleaned-up React effect cancel before opening a socket.
  await Promise.resolve();
  if (options?.signal?.aborted) throw new Error("Request cancelled.");
  let response: Response;
  // Network loss does not always reject fetch immediately (e.g. a stalled TCP
  // connection). Bound both headers and body reading so the form can be retried.
  const timeout = AbortSignal.timeout(10000);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let body: unknown;
  const canRetry = (options?.method ?? "GET").toUpperCase() === "GET";
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(`/api${path}`, {
        ...options,
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (canRetry && attempt === 0 && response.status >= 500) {
        await response.body?.cancel();
        await waitForReadRetry(signal);
        continue;
      }
      if (response.status === 204) return null;
      body = await response.json();
      break;
    } catch {
      if (options?.signal?.aborted) throw new Error("Request cancelled.");
      if (timeout.aborted)
        throw new Error("The request timed out. Please try again.");
      if (canRetry && attempt === 0) {
        await waitForReadRetry(signal);
        continue;
      }
      throw new Error("Could not reach the server. Please try again.");
    }
  }
  if (!response.ok) {
    let message = "Something went wrong. Please try again.";
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
    )
      message = body.error.message;
    const details = isRecord(body) && isRecord(body.error) ? body.error : {};
    throw new ApiError(
      response.status,
      message,
      typeof details.code === "string" ? details.code : undefined,
      typeof details.field === "string" ? details.field : undefined,
    );
  }
  return body;
}

function waitForReadRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Request cancelled or timed out."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 250);
    function cancel() {
      clearTimeout(timer);
      reject(new Error("Request cancelled or timed out."));
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
