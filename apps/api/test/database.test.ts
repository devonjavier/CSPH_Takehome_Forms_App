import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
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
            client.on("error", () => {});
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
