import assert from "node:assert/strict";
import test from "node:test";
import { requestApi } from "../app/api-client.ts";

test("disconnection and truncated bodies reject; retry succeeds", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("network disconnected");
  });
  await assert.rejects(requestApi("/auth/login"), /Could not reach the server/);
  fetchMock.mock.mockImplementation(
    async () => new Response("{", { status: 200 }),
  );
  await assert.rejects(requestApi("/auth/login"), /Could not reach the server/);
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
