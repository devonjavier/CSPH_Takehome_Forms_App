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
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new Error("Could not reach the server. Please try again.");
  }
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
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
