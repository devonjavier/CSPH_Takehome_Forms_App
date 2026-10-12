import type { ErrorRequestHandler } from "express";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export const handleError: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof URIError && "status" in error && error.status === 400) {
    response.status(400).json({
      error: { code: "INVALID_PATH", message: "Use a valid URL path." },
    });
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.field ? { field: error.field } : {}),
      },
    });
    return;
  }
  if (typeof error === "object" && error !== null && "type" in error) {
    if (error.type === "entity.parse.failed") {
      response.status(400).json({
        error: { code: "INVALID_JSON", message: "Send a valid JSON object." },
      });
      return;
    }
    if (error.type === "entity.too.large") {
      response.status(413).json({
        error: {
          code: "BODY_TOO_LARGE",
          message: "The request is too large.",
        },
      });
      return;
    }
  }
  console.error("An API operation failed.");
  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
    },
  });
};
