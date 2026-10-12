import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, requestApi } from "../app/api-client.ts";

test("submission errors retain safe field and stale-version codes for the UI", async (context) => {
  const fetchMock = context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "INVALID_SUBMISSION",
            message: "Answer this required question.",
            field: "question-id",
          },
        }),
        { status: 400 },
      ),
  );
  await assert.rejects(
    requestApi("/public/forms/example/responses"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.field, "question-id");
      assert.equal(error.code, "INVALID_SUBMISSION");
      assert.equal(error.status, 400);
      return true;
    },
  );
  fetchMock.mock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: "FORM_UPDATED", message: "Please refresh." },
        }),
        { status: 409 },
      ),
  );
  await assert.rejects(
    requestApi("/public/forms/example/responses"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "FORM_UPDATED");
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test("disconnection and truncated bodies reject; retry succeeds", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("network disconnected");
  });
  await assert.rejects(
    requestApi("/auth/login", { method: "POST" }),
    /Could not reach the server/,
  );
  fetchMock.mock.mockImplementation(
    async () => new Response("{", { status: 200 }),
  );
  await assert.rejects(
    requestApi("/auth/login", { method: "POST" }),
    /Could not reach the server/,
  );
  fetchMock.mock.mockImplementation(
    async () =>
      new Response('{"user":{"email":"test@example.test"}}', { status: 200 }),
  );
  assert.deepEqual(await requestApi("/auth/me"), {
    user: { email: "test@example.test" },
  });
});

test("stalled requests use the configured timeout and reject", async (context) => {
  const controller = new AbortController();
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 10000);
    return controller.signal;
  });
  context.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options?: RequestInit) => {
      assert.ok(options?.signal);
      if (options.signal.aborted) throw new Error("aborted");
      return new Promise<Response>((_resolve, reject) =>
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    },
  );
  const result = assert.rejects(requestApi("/auth/login"), /request timed out/);
  controller.abort();
  await result;
});

test("GET recovers once from a reset or proxy failure, but never retries writes or 401", async (context) => {
  let calls = 0;
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new TypeError("ECONNRESET");
    return new Response('{"forms":[]}');
  });
  assert.deepEqual(await requestApi("/forms"), { forms: [] });
  assert.equal(calls, 2);
  calls = 0;
  fetchMock.mock.mockImplementation(async () => {
    calls++;
    return calls === 1
      ? new Response("Internal Server Error", { status: 500 })
      : new Response('{"user":{}}');
  });
  assert.deepEqual(await requestApi("/auth/me"), { user: {} });
  assert.equal(calls, 2);
  for (const method of ["POST", "PUT", "DELETE"]) {
    calls = 0;
    fetchMock.mock.mockImplementation(async () => {
      calls++;
      throw new TypeError("reset");
    });
    await assert.rejects(requestApi("/forms", { method }), /Could not reach/);
    assert.equal(calls, 1);
  }
  calls = 0;
  fetchMock.mock.mockImplementation(async () => {
    calls++;
    return new Response('{"error":{"message":"Sign in"}}', { status: 401 });
  });
  await assert.rejects(
    requestApi("/auth/me"),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(calls, 1);
});

test("read retries are bounded and immediate effect cleanup opens no connection", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("reset");
  });
  await assert.rejects(requestApi("/forms"), /Could not reach/);
  assert.equal(fetchMock.mock.callCount(), 2);
  const controller = new AbortController();
  const pending = requestApi("/auth/me", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(fetchMock.mock.callCount(), 2);
});
