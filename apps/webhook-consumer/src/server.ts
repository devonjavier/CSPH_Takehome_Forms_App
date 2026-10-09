import express from "express";

const port = Number(process.env.PORT ?? "4001");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const app = express();
app.disable("x-powered-by");
app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "webhook-consumer" });
});
app.get("/", (_request, response) => {
  response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webhook consumer</title></head>
<body><main><h1>Webhook consumer</h1><p>The consumer scaffold is running.</p>
<p>Webhook receiving and the delivery list will be added in HOOK-02.</p></main></body></html>`);
});
app.use((_request, response) => {
  response.status(404).json({
    error: { code: "NOT_FOUND", message: "This endpoint does not exist." },
  });
});

const server = app.listen(port, () => {
  console.log(`Webhook consumer listening on http://localhost:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
