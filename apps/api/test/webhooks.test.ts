import { drainWebhooks, scheduleWebhook } from "../src/webhooks.js";
import { submitResponse } from "../src/responses.js";
import { readPublicForm } from "../src/public-definition.js";
import { parsePublicForm, type PublicForm } from "../src/contracts/draft.js";
import type { Submission } from "../src/contracts/submission.js";
import { createConsumerApp } from "../../webhook-consumer/src/app.js";
function validSubmission(form: PublicForm): Submission {
  return {
    formVersionId: form.formVersionId,
    email: "respondent@example.test",
    answers: form.questions.map((question) => {
      let value: unknown;
      switch (question.type) {
        case "short_text":
          value = "Dev 🐱";
          break;
        case "long_text":
          value = "Line one\n=SUM(A1:A2)";
          break;
        case "date":
          value = "2024-02-29";
          break;
        case "linear_scale":
          value = question.min;
          break;
        case "dropdown":
        case "multiple_choice":
          value = question.options[0]?.id;
          break;
        case "checkboxes":
        case "multi_select":
          value = question.options
            .slice(0, 2)
            .reverse()
            .map((option) => option.id);
          break;
      }
      return { questionId: question.id, value };
    }),
  };
}

import { createServer } from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../src/app.js";
import { readAuthConfig } from "../src/auth.js";
import { createDatabasePool } from "../src/database.js";
import { fixtureId, seedFixtures, demoPassword } from "../scripts/fixtures.js";
import { archiveForm } from "../src/form-drafts.js";
import {
  readWebhookOrigins,
  assertWebhookDestination,
} from "../src/webhook-policy.js";

test("production requires an exact trusted webhook-origin allowlist", () => {
  assert.throws(
    () => readWebhookOrigins({ NODE_ENV: "production" }),
    /WEBHOOK_ALLOWED_ORIGINS/,
  );
  const allowed = readWebhookOrigins({
    NODE_ENV: "production",
    WEBHOOK_ALLOWED_ORIGINS:
      "https://receiver.example.test,http://127.0.0.1:4001",
  });
  for (const url of [
    "https://receiver.example.test/path",
    "http://127.0.0.1:4001/webhooks",
  ])
    assert.doesNotThrow(() => assertWebhookDestination(new URL(url), allowed));
  for (const url of [
    "http://169.254.169.254/latest/meta-data",
    "https://receiver.example.test.evil.test",
    "https://receiver.example.test:444",
    "http://receiver.example.test",
  ])
    assert.throws(
      () => assertWebhookDestination(new URL(url), allowed),
      /not allowed/,
    );
  for (const entry of [
    "*",
    "https://receiver.example.test/path",
    "https://user:secret@example.test",
    "https://example.test/",
  ])
    assert.throws(() => readWebhookOrigins({ WEBHOOK_ALLOWED_ORIGINS: entry }));
});

test("webhooks commit first and preserve owner boundaries", async (suite) => {
  const schema = `webhook_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabasePool();
  const pool = createDatabasePool();
  pool.options.options = `-c search_path=${schema}`;
  const config = readAuthConfig({
    JWT_SECRET: "owned-response-tests-at-least-32-bytes",
    WEB_ORIGIN: "http://localhost:3000",
  });
  const server = createApp(pool, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string, cookie = "") =>
    fetch(base + path, { headers: { Cookie: cookie } });
  async function login(email: string) {
    const result = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { Origin: config.webOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: demoPassword }),
    });
    assert.equal(result.status, 200);
    const cookie = result.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    return cookie;
  }
  const formId = fixtureId("survey");
  const path = `/forms/${formId}/webhook`;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const directory = new URL(
        "../../../database/migrations/",
        import.meta.url,
      );
      for (const file of (await readdir(directory))
        .filter((name) => /^\d{3}_.*\.sql$/.test(name))
        .sort())
        await client.query(await readFile(new URL(file, directory), "utf8"));
      await seedFixtures(client);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const alpha = await login("owner.alpha@example.test");
    const beta = await login("owner.beta@example.test");
    let received: unknown;
    let receiverSecret: string | undefined;
    let committed = false;
    let mode = "success";
    const receiver = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      received = JSON.parse(raw);
      receiverSecret = String(request.headers["x-webhook-secret"]);
      const parsed = JSON.parse(raw);
      committed =
        (
          await pool.query("SELECT 1 FROM responses WHERE id=$1", [
            parsed.response.id,
          ])
        ).rowCount === 1;
      if (mode === "slow") return;
      if (mode === "redirect") {
        response.writeHead(302, {
          Location: "http://127.0.0.1:1/should-not-follow",
        });
        response.end();
        return;
      }
      response.statusCode =
        mode === "failure" ? 503 : receiverSecret === "test-secret" ? 204 : 401;
      response.end();
    }).listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const receiverAddress = receiver.address();
    assert.ok(receiverAddress && typeof receiverAddress !== "string");
    const receiverUrl = `http://127.0.0.1:${receiverAddress.port}/webhooks`;
    const put = (body: unknown, cookie = alpha) =>
      fetch(base + path, {
        method: "PUT",
        headers: {
          Cookie: cookie,
          Origin: config.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const definition = parsePublicForm(
      await readPublicForm(pool, "demo-survey"),
    );
    const submission = validSubmission(definition);
    async function submit() {
      const result = await fetch(base + "/public/forms/demo-survey/responses", {
        method: "POST",
        headers: {
          Origin: config.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(submission),
      });
      assert.equal(result.status, 201);
      const body = await result.text();
      assert.ok(!body.includes("secret") && !body.includes(receiverUrl));
      const parsed = JSON.parse(body);
      return String(parsed.response.id);
    }
    async function attemptFor(responseId: string) {
      await drainWebhooks(pool);
      const attempts = await pool.query(
        "SELECT * FROM webhook_attempts WHERE response_id=$1",
        [responseId],
      );
      assert.equal(attempts.rowCount, 1);
      return attempts.rows[0];
    }
    try {
      await suite.test(
        "persisted destinations are rechecked before sending and blocked attempts are logged",
        async () => {
          const previous = process.env.WEBHOOK_ALLOWED_ORIGINS;
          try {
            process.env.WEBHOOK_ALLOWED_ORIGINS =
              "https://trusted.example.test";
            assert.equal(
              (await put({ url: receiverUrl, secret: "test-secret" })).status,
              400,
            );
            // The seed has a local destination saved before this policy was applied.
            const responseId = await submit();
            const attempt = await attemptFor(responseId);
            assert.equal(attempt.status_code, null);
            assert.equal(
              attempt.error_message,
              "Webhook destination is blocked by server policy.",
            );
            assert.equal(received, undefined);
          } finally {
            if (previous === undefined)
              delete process.env.WEBHOOK_ALLOWED_ORIGINS;
            else process.env.WEBHOOK_ALLOWED_ORIGINS = previous;
          }
        },
      );
      await suite.test(
        "owner settings validation and write-only secret",
        async () => {
          assert.equal((await get(path)).status, 401);
          assert.equal((await get(path, beta)).status, 404);
          assert.equal(
            (await put({ url: receiverUrl, secret: "test-secret" }, beta))
              .status,
            404,
          );
          for (const url of [
            "file:///tmp/a",
            "ftp://example.test",
            "http://user:pass@example.test",
            "https://example.test/#fragment",
          ])
            assert.equal(
              (await put({ url, secret: "test-secret" })).status,
              400,
            );
          assert.equal(
            (await put({ url: receiverUrl, secret: "bad\r\nheader" })).status,
            400,
          );
          assert.equal(
            (await put({ url: receiverUrl, secret: "test-secret" })).status,
            204,
          );
          assert.equal((await put({ url: receiverUrl })).status, 204);
          const settings = await get(path, alpha);
          assert.equal(settings.headers.get("cache-control"), "no-store");
          assert.ok(!(await settings.text()).includes("test-secret"));
        },
      );
      await suite.test(
        "success delivers only committed response with original labels and typed answers",
        async () => {
          const id = await submit();
          const attempt = await attemptFor(id);
          assert.equal(attempt.status_code, 204);
          assert.equal(attempt.error_message, null);
          assert.ok(committed);
          assert.equal(receiverSecret, "test-secret");
          assert.ok(
            received && typeof received === "object" && "response" in received,
          );
          const payload = JSON.parse(JSON.stringify(received));
          assert.equal(payload.form.formVersionId, definition.formVersionId);
          assert.equal(payload.response.answers.length, 8);
          for (const [index, question] of definition.questions.entries()) {
            const answer = payload.response.answers[index];
            assert.equal(answer.questionId, question.id);
            assert.equal(answer.label, question.label);
            assert.equal(answer.type, question.type);
            if (question.type === "date")
              assert.equal(answer.value, "2024-02-29");
            if (question.type === "linear_scale")
              assert.equal(answer.value, question.min);
            if ("options" in question)
              assert.ok(
                JSON.stringify(answer.value).includes(
                  question.options[0]?.label ?? "",
                ),
              );
          }
        },
      );
      await suite.test(
        "accepted submission keeps its webhook snapshot after settings change",
        async () => {
          const accepted = await submitResponse(
            pool,
            "demo-survey",
            submission,
          );
          assert.ok(accepted.webhook);
          await put({
            url: "http://127.0.0.1:1/changed",
            secret: "replacement-secret",
          });
          scheduleWebhook(pool, accepted.webhook);
          const attempt = await attemptFor(accepted.response.id);
          assert.equal(attempt.destination_url, receiverUrl);
          assert.equal(attempt.status_code, 204);
          assert.equal(receiverSecret, "test-secret");
          await put({ url: receiverUrl, secret: "test-secret" });
        },
      );
      await suite.test(
        "invalid submissions never schedule a webhook",
        async () => {
          const before = (
            await pool.query("SELECT count(*) FROM webhook_attempts")
          ).rows[0].count;
          const rejected = await fetch(
            base + "/public/forms/demo-survey/responses",
            {
              method: "POST",
              headers: {
                Origin: config.webOrigin,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ ...submission, answers: [] }),
            },
          );
          assert.equal(rejected.status, 400);
          await drainWebhooks(pool);
          assert.equal(
            (await pool.query("SELECT count(*) FROM webhook_attempts")).rows[0]
              .count,
            before,
          );
        },
      );
      await suite.test(
        "wrong secret, non-2xx and redirects log failures without failing submissions",
        async () => {
          await put({ url: receiverUrl, secret: "wrong" });
          assert.equal((await attemptFor(await submit())).status_code, 401);
          await put({ url: receiverUrl, secret: "test-secret" });
          for (const [receiverMode, status] of [
            ["failure", 503],
            ["redirect", 302],
          ] as const) {
            mode = receiverMode;
            const attempt = await attemptFor(await submit());
            assert.equal(attempt.status_code, status);
            assert.match(attempt.error_message, /Receiver returned HTTP/);
          }
        },
      );
      await suite.test(
        "slow receiver does not hold submission open; timeout logs null status",
        async () => {
          mode = "slow";
          const started = Date.now();
          const id = await submit();
          assert.ok(
            Date.now() - started < 4000,
            "submission waited for five-second webhook timeout",
          );
          const attempt = await attemptFor(id);
          assert.equal(attempt.status_code, null);
          assert.equal(attempt.error_message, "Delivery timed out.");
        },
      );
      await suite.test(
        "attempt logging failures never undo committed submissions or escape as rejected jobs",
        async () => {
          const diagnostic = suite.mock.method(console, "error", () => {});
          mode = "success";
          await pool.query(
            `CREATE FUNCTION reject_attempt_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test log unavailable'; END $$`,
          );
          try {
            for (const operation of ["INSERT", "UPDATE"]) {
              await pool.query(
                `CREATE TRIGGER reject_attempt_log BEFORE ${operation} ON webhook_attempts FOR EACH ROW EXECUTE FUNCTION reject_attempt_log()`,
              );
              try {
                const id = await submit();
                await drainWebhooks(pool);
                assert.equal(
                  (
                    await pool.query("SELECT 1 FROM responses WHERE id=$1", [
                      id,
                    ])
                  ).rowCount,
                  1,
                );
                const attempts = await pool.query(
                  "SELECT completed_at FROM webhook_attempts WHERE response_id=$1",
                  [id],
                );
                assert.equal(attempts.rowCount, operation === "INSERT" ? 0 : 1);
                if (operation === "UPDATE")
                  assert.equal(attempts.rows[0].completed_at, null);
              } finally {
                await pool.query(
                  "DROP TRIGGER reject_attempt_log ON webhook_attempts",
                );
              }
            }
            assert.equal(diagnostic.mock.callCount(), 2);
            for (const call of diagnostic.mock.calls)
              assert.deepEqual(call.arguments, [
                "Webhook delivery or attempt logging failed.",
              ]);
          } finally {
            diagnostic.mock.restore();
            await pool.query("DROP FUNCTION reject_attempt_log()");
          }
        },
      );
      await suite.test(
        "real consumer accepts a public submission and displays its historical answers",
        async () => {
          const consumer = createConsumerApp("consumer-secret").listen(
            0,
            "127.0.0.1",
          );
          await once(consumer, "listening");
          try {
            const consumerAddress = consumer.address();
            assert.ok(consumerAddress && typeof consumerAddress !== "string");
            const consumerBase = `http://127.0.0.1:${consumerAddress.port}`;
            assert.equal(
              (
                await put({
                  url: consumerBase + "/webhooks",
                  secret: "consumer-secret",
                })
              ).status,
              204,
            );
            const id = await submit();
            assert.equal((await attemptFor(id)).status_code, 204);
            const page = await (await fetch(consumerBase)).text();
            assert.ok(page.includes(id) && page.includes(submission.email));
            assert.ok(
              page.includes(definition.formVersionId) &&
                page.includes("2024-02-29"),
            );
            assert.ok(!page.includes("consumer-secret"));
            await put({
              url: consumerBase + "/webhooks",
              secret: "wrong-secret",
            });
            const rejectedId = await submit();
            assert.equal((await attemptFor(rejectedId)).status_code, 401);
            assert.ok(
              !(await (await fetch(consumerBase)).text()).includes(rejectedId),
            );
          } finally {
            await drainWebhooks(pool);
            await new Promise<void>((resolve) =>
              consumer.close(() => resolve()),
            );
            await put({ url: receiverUrl, secret: "test-secret" });
          }
        },
      );
      await suite.test(
        "connection failure, disable and archive retain safe owner-only logs",
        async () => {
          receiver.closeAllConnections();
          await new Promise<void>((resolve) => receiver.close(() => resolve()));
          const failed = await attemptFor(await submit());
          assert.equal(failed.status_code, null);
          assert.equal(
            failed.error_message,
            "Could not connect to webhook receiver.",
          );
          assert.equal(
            (
              await fetch(base + path, {
                method: "DELETE",
                headers: { Cookie: alpha, Origin: config.webOrigin },
              })
            ).status,
            204,
          );
          const id = await submit();
          await drainWebhooks(pool);
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM webhook_attempts WHERE response_id=$1",
                [id],
              )
            ).rowCount,
            0,
          );
          const logs = await (await get(path, alpha)).text();
          assert.ok(
            logs.includes("Could not connect") && !logs.includes("test-secret"),
          );
          await archiveForm(pool, fixtureId("alpha"), formId);
          assert.equal((await get(path, alpha)).status, 404);
          assert.equal(
            (await put({ url: receiverUrl, secret: "test-secret" })).status,
            404,
          );
        },
      );
    } finally {
      receiver.closeAllConnections();
      receiver.close();
      await drainWebhooks(pool);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
