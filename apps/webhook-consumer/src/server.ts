import { createConsumerApp } from "./app.js";

const port = Number(process.env.PORT ?? "4001");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const app = createConsumerApp(process.env.WEBHOOK_SECRET ?? "");

// The demonstration list contains respondent data and is local-only.
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Webhook consumer listening on http://localhost:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
