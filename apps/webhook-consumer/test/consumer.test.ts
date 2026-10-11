import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createConsumerApp } from "../src/app.js";

test("consumer authenticates, bounds history and safely displays received JSON", async () => {
  for (const secret of [
    "",
    "contains space",
    "bad\r\nheader",
    "x".repeat(513),
  ]) {
    assert.throws(() => createConsumerApp(secret), /WEBHOOK_SECRET/);
  }
  const server = createConsumerApp("test-secret").listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (
    body: string,
    secret = "test-secret",
    contentType = "application/json",
  ) =>
    fetch(base + "/webhooks", {
      method: "POST",
      headers: { "X-Webhook-Secret": secret, "Content-Type": contentType },
      body,
    });
  try {
    assert.match(await (await fetch(base)).text(), /No deliveries received/);
    assert.equal(
      (await fetch(base + "/webhooks", { method: "POST" })).status,
      401,
    );
    assert.equal((await post("{", "wrong")).status, 401);
    assert.equal((await post("{}", "test-secret", "text/plain")).status, 415);
    assert.equal((await post("{")).status, 400);
    assert.equal((await post("[]")).status, 400);
    assert.equal((await post("null")).status, 400);
    assert.equal(
      (await post(JSON.stringify({ text: "x".repeat(4 * 1024 * 1024) })))
        .status,
      413,
    );
    const duplicateStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          base + "/webhooks",
          {
            method: "POST",
            headers: {
              "X-Webhook-Secret": ["test-secret", "test-secret"],
              "Content-Type": "application/json",
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
        request.end("{}");
      },
    );
    assert.equal(duplicateStatus, 401);
    assert.match(await (await fetch(base)).text(), /No deliveries received/);
    assert.equal(
      (await post(JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) })))
        .status,
      204,
    );
    assert.equal(
      (
        await post(
          JSON.stringify({
            text: "<script>alert('x')</script>",
            unicode: "🐱",
            blank: null,
            selected: ["one", "two"],
          }),
        )
      ).status,
      204,
    );
    const page = await fetch(base);
    const html = await page.text();
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'none'/,
    );
    assert.ok(!html.includes("<script>") && !html.includes("test-secret"));
    assert.ok(html.includes("&lt;script&gt;") && html.includes("🐱"));
    for (let index = 0; index < 51; index++) {
      assert.equal(
        (await post(JSON.stringify({ marker: `delivery-${index}-end` })))
          .status,
        204,
      );
    }
    const history = await (await fetch(base)).text();
    assert.ok(!history.includes("delivery-0-end"));
    assert.ok(
      history.indexOf("delivery-50-end") < history.indexOf("delivery-1-end"),
    );
    assert.equal((history.match(/<article>/g) ?? []).length, 50);
    assert.equal((await fetch(base + "/missing")).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const restarted = createConsumerApp("test-secret").listen(0, "127.0.0.1");
  await once(restarted, "listening");
  try {
    const restartedAddress = restarted.address();
    assert.ok(restartedAddress && typeof restartedAddress !== "string");
    assert.match(
      await (await fetch(`http://127.0.0.1:${restartedAddress.port}`)).text(),
      /No deliveries received/,
    );
  } finally {
    await new Promise<void>((resolve) => restarted.close(() => resolve()));
  }
});
