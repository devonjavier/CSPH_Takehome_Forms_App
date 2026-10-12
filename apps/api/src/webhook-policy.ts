import { HttpError } from "./errors.js";

// Deployment operators choose trusted receiver origins. This is not DNS-based
// private-IP detection: production still needs network egress restrictions.
export function readWebhookOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  const configured = env.WEBHOOK_ALLOWED_ORIGINS;
  if (!configured?.trim()) {
    if (env.NODE_ENV === "production")
      throw new Error(
        "WEBHOOK_ALLOWED_ORIGINS must name trusted receivers in production.",
      );
    return null;
  }
  return configured.split(",").map((entry) => {
    const value = entry.trim();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
      throw new Error(
        "WEBHOOK_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths.",
      );
    return value;
  });
}

export function assertWebhookDestination(
  url: URL,
  origins = readWebhookOrigins(),
) {
  if (origins && !origins.includes(url.origin))
    throw new HttpError(
      400,
      "WEBHOOK_DESTINATION_BLOCKED",
      "This webhook destination is not allowed by the server configuration.",
    );
}
