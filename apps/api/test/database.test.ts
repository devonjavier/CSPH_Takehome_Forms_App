import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";
import { createApp } from "../src/app.js";
import { createDatabasePool, withTransaction } from "../src/database.js";

// Only the test command loads root Compose settings. Production uses PG* values.
const testEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "127.0.0.1",
  PGPORT: process.env.PGPORT ?? process.env.POSTGRES_PORT ?? "5432",
  PGUSER: process.env.PGUSER ?? process.env.POSTGRES_USER,
  PGDATABASE: process.env.PGDATABASE ?? process.env.POSTGRES_DB,
  PGPASSWORD: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD,
};

test("database configuration rejects missing credentials without printing them", () => {
  assert.throws(() => createDatabasePool({}), /Set PGUSER/);
  assert.throws(
    () => createDatabasePool({ ...testEnvironment, PGPORT: "invalid" }),
    /PGPORT/,
  );
});

test("real PostgreSQL transactions and HTTP readiness", async (suite) => {
  const pool = createDatabasePool(testEnvironment);
  let poolClosed = false;
  try {
    // Session-local fixtures vanish on pool shutdown; no application records touched.
    await pool.query(
      "CREATE TEMP TABLE db02_probe (id integer PRIMARY KEY, label text NOT NULL)",
    );

    await suite.test(
      "commit returns a value, persists writes, and releases the client",
      async () => {
        const result = await withTransaction(pool, async (client) => {
          await client.query("INSERT INTO db02_probe VALUES ($1, $2)", [
            1,
            "committed",
          ]);
          await client.query("UPDATE db02_probe SET label = $1 WHERE id = $2", [
            "updated",
            1,
          ]);
          return "saved";
        });
        assert.equal(result, "saved");
        const saved = await pool.query<{ label: string }>(
          "SELECT label FROM db02_probe WHERE id = $1",
          [1],
        );
        assert.equal(saved.rows[0]?.label, "updated");
        assert.equal(pool.totalCount, pool.idleCount);
      },
    );

    await suite.test(
      "callback failure rolls back all its writes and preserves the original error",
      async () => {
        const originalError = new Error("deliberate rollback");
        await assert.rejects(
          withTransaction(pool, async (client) => {
            await client.query("INSERT INTO db02_probe VALUES ($1, $2)", [
              2,
              "rolled back",
            ]);
            throw originalError;
          }),
          (error: unknown) => error === originalError,
        );
        const saved = await pool.query(
          "SELECT id FROM db02_probe WHERE id = 2",
        );
        assert.equal(saved.rowCount, 0);
        assert.equal(pool.totalCount, pool.idleCount);
      },
    );

    await suite.test(
      "constraint failure rolls back preceding writes; connection remains usable",
      async () => {
        await assert.rejects(
          withTransaction(pool, async (client) => {
            await client.query(
              "INSERT INTO db02_probe VALUES (3, 'first write')",
            );
            await client.query(
              "INSERT INTO db02_probe VALUES (1, 'duplicate')",
            );
          }),
          { code: "23505" },
        );
        const saved = await pool.query(
          "SELECT id FROM db02_probe WHERE id = 3",
        );
        assert.equal(saved.rowCount, 0);
        await withTransaction(pool, async (client) => {
          await client.query(
            "INSERT INTO db02_probe VALUES (4, 'reused connection')",
          );
        });
      },
    );

    await suite.test(
      "swallowed SQL errors cannot produce a false commit success",
      async () => {
        await assert.rejects(
          withTransaction(pool, async (client) => {
            await client.query(
              "INSERT INTO db02_probe VALUES (5, 'must roll back')",
            );
            try {
              await client.query("SELECT 1 / 0");
            } catch {
              // Deliberately simulate a caller swallowing a database failure.
            }
          }),
          /could not commit/,
        );
        assert.equal(
          (await pool.query("SELECT id FROM db02_probe WHERE id = 5")).rowCount,
          0,
        );
      },
    );

    await suite.test(
      "native DATE remains a date string, timestamps remain instants",
      async () => {
        const result = await pool.query<{
          answer_date: string;
          submitted_at: Date;
        }>(
          "SELECT DATE '2026-10-10' AS answer_date, TIMESTAMPTZ '2026-10-10 00:00:00+00' AS submitted_at",
        );
        assert.equal(result.rows[0]?.answer_date, "2026-10-10");
        assert.equal(
          result.rows[0]?.submitted_at.toISOString(),
          "2026-10-10T00:00:00.000Z",
        );
      },
    );

    await suite.test(
      "broken transaction connection is discarded and the pool recovers",
      async () => {
        await assert.rejects(
          withTransaction(pool, async (client) => {
            // Terminate only this test's own backend to exercise rollback failure.
            await client.query("SELECT pg_terminate_backend(pg_backend_pid())");
          }),
        );
        await pool.query("SELECT 1");
        assert.equal(pool.totalCount, pool.idleCount);
      },
    );

    await suite.test(
      "ready succeeds, then returns sanitized 503 while liveness stays available",
      async () => {
        const server = createApp(pool).listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        try {
          assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
          await pool.end();
          poolClosed = true;
          assert.equal(pool.totalCount, 0);
          const unavailable = await fetch(`${baseUrl}/ready`);
          assert.equal(unavailable.status, 503);
          assert.deepEqual(await unavailable.json(), {
            error: {
              code: "DATABASE_UNAVAILABLE",
              message: "The database is temporarily unavailable.",
            },
          });
          assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  } finally {
    if (!poolClosed) await pool.end();
  }
});

test("client error events reject successful callbacks and discard the connection", async () => {
  const pool = createDatabasePool(testEnvironment);
  const connectionError = new Error("simulated checked-out connection failure");
  try {
    await assert.rejects(
      withTransaction(pool, async (client) => {
        client.emit("error", connectionError);
        // Emitting does not break the underlying socket. Without the explicit
        // failure check, this callback could incorrectly commit and return success.
        return "must not succeed";
      }),
      (error: unknown) => error === connectionError,
    );
    assert.equal(pool.totalCount, 0);
    await pool.query("SELECT 1");
    assert.equal(pool.totalCount, pool.idleCount);

    // Reusing healthy clients must not accumulate transaction error listeners.
    for (let attempt = 0; attempt < 3; attempt++) {
      await withTransaction(pool, async (client) => {
        assert.equal(client.listenerCount("error"), 1);
        await client.query("SELECT 1");
      });
    }
    const client = await pool.connect();
    try {
      assert.equal(client.listenerCount("error"), 0);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});

test("idle transaction connection loss does not crash the process and the pool recovers", async () => {
  // Run the actual helper in a separate process: an unhandled EventEmitter error
  // must fail this test, never be hidden by the test runner or a test-only listener.
  const databaseModuleUrl = new URL("../src/database.ts", import.meta.url).href;
  const childSource = `
    import assert from "node:assert/strict";
    import { setTimeout as delay } from "node:timers/promises";
    import { createDatabasePool, withTransaction } from ${JSON.stringify(databaseModuleUrl)};
    const pool = createDatabasePool();
    try {
      const before = await pool.query("SELECT pg_backend_pid() AS pid");
      await assert.rejects(withTransaction(pool, async (client) => {
        await client.query("SET LOCAL idle_in_transaction_session_timeout='100ms'");
        await delay(750);
        return "must not commit";
      }), { code: "25P03" });
      assert.equal(pool.totalCount, 0);
      const after = await pool.query("SELECT pg_backend_pid() AS pid");
      assert.notEqual(after.rows[0].pid, before.rows[0].pid);
      assert.equal(pool.totalCount, pool.idleCount);
      console.log("Connection failure handled; pool recovered.");
    } finally {
      await pool.end();
    }
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childSource],
    { env: testEnvironment, timeout: 15000 },
  );
  assert.match(stdout, /Connection failure handled; pool recovered/);
  assert.equal(stderr, "");
});
