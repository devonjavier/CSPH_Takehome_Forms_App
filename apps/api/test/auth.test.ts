import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { SignJWT } from "jose";
import { createApp } from "../src/app.js";
import {
  readAuthConfig,
  sessionCookieName,
  tokenAudience,
  tokenIssuer,
} from "../src/auth.js";
import { createDatabasePool } from "../src/database.js";
import { verifyPassword } from "../src/passwords.js";
import { demoPassword, fixtureId, seedFixtures } from "../scripts/fixtures.js";

const config = readAuthConfig({
  JWT_SECRET: "auth-tests-only-secret-at-least-32-bytes",
  WEB_ORIGIN: "http://localhost:3000",
});

test("authentication configuration fails closed", () => {
  assert.throws(() => readAuthConfig({}), /JWT_SECRET/);
  assert.throws(() => readAuthConfig({ JWT_SECRET: "short" }), /JWT_SECRET/);
  assert.throws(
    () =>
      readAuthConfig({
        JWT_SECRET: "x".repeat(32),
        WEB_ORIGIN: "http://localhost:3000/",
      }),
    /WEB_ORIGIN/,
  );
  assert.throws(
    () =>
      readAuthConfig({ JWT_SECRET: "x".repeat(32), NODE_ENV: "production" }),
    /HTTPS/,
  );
  assert.equal(
    readAuthConfig({
      JWT_SECRET: "x".repeat(32),
      NODE_ENV: "production",
      WEB_ORIGIN: "https://forms.example.test",
    }).secureCookies,
    true,
  );
});

test("authentication and owner boundaries over HTTP with PostgreSQL", async (suite) => {
  const pool = createDatabasePool();
  // One backend keeps HTTP-handler queries in our rollback-only transaction.
  // Production retains its normal ten-client pool and independent transactions.
  pool.options.max = 1;
  const server = createApp(pool, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, init);
  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { Origin: config.webOrigin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  function session(response: Response): string {
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=3600/);
    const pair = cookie.split(";")[0];
    assert.ok(pair);
    return pair;
  }
  let alphaCookie = "";
  let betaCookie = "";
  try {
    await pool.query("BEGIN");
    const schema = `auth_test_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET LOCAL search_path TO ${schema}`);
    const directory = new URL("../../../database/migrations/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter((name) => /^\d{3}_.*\.sql$/.test(name))
      .sort())
      await pool.query(await readFile(new URL(file, directory), "utf8"));
    const client = await pool.connect();
    try {
      await seedFixtures(client);
    } finally {
      client.release();
    }

    await suite.test(
      "seeded owners can log in and cookies expose no password/token JSON",
      async () => {
        const alpha = await post("/auth/login", {
          email: " OWNER.ALPHA@EXAMPLE.TEST ",
          password: demoPassword,
        });
        assert.equal(alpha.status, 200);
        alphaCookie = session(alpha);
        assert.equal(alpha.headers.get("cache-control"), "no-store");
        assert.deepEqual(await alpha.json(), {
          user: { id: fixtureId("alpha"), email: "owner.alpha@example.test" },
        });
        const beta = await post("/auth/login", {
          email: "owner.beta@example.test",
          password: demoPassword,
        });
        assert.equal(beta.status, 200);
        betaCookie = session(beta);
        const me = await request("/auth/me", {
          headers: { Cookie: alphaCookie },
        });
        assert.equal(me.status, 200);
        assert.deepEqual(await me.json(), {
          user: { id: fixtureId("alpha"), email: "owner.alpha@example.test" },
        });
      },
    );

    await suite.test(
      "registration normalizes email, hashes password and ignores claimed identity",
      async () => {
        const registered = await post("/auth/register", {
          email: " New.Owner@Example.test ",
          password: demoPassword,
          id: fixtureId("alpha"),
          owner_id: fixtureId("alpha"),
        });
        assert.equal(registered.status, 201);
        const newCookie = session(registered);
        const saved = await pool.query<{ id: string; password_hash: string }>(
          "SELECT id,password_hash FROM users WHERE email='new.owner@example.test'",
        );
        const user = saved.rows[0];
        assert.ok(user);
        assert.notEqual(user.id, fixtureId("alpha"));
        assert.notEqual(user.password_hash, demoPassword);
        assert.equal(
          await verifyPassword(demoPassword, user.password_hash),
          true,
        );
        const listing = await request("/forms", {
          headers: { Cookie: newCookie },
        });
        assert.deepEqual(await listing.json(), { forms: [] });
        const duplicate = await post("/auth/register", {
          email: "NEW.OWNER@example.test",
          password: demoPassword,
        });
        assert.equal(duplicate.status, 409);
        const raced = await Promise.all([
          post("/auth/register", {
            email: "race@example.test",
            password: demoPassword,
          }),
          post("/auth/register", {
            email: "race@example.test",
            password: demoPassword,
          }),
        ]);
        assert.deepEqual(
          raced.map((response) => response.status).sort(),
          [201, 409],
        );
      },
    );

    await suite.test(
      "invalid bodies and login failures return consistent safe errors",
      async () => {
        for (const body of [
          null,
          [],
          {},
          { email: "invalid", password: demoPassword },
          { email: "valid@example.test", password: "short" },
          { email: "valid@example.test", password: " ".repeat(12) },
          { email: "valid@example.test", password: "x".repeat(129) },
        ]) {
          assert.equal((await post("/auth/register", body)).status, 400);
        }
        const wrongPassword = await post("/auth/login", {
          email: "owner.alpha@example.test",
          password: "wrong-password-123",
        });
        const absent = await post("/auth/login", {
          email: "absent@example.test",
          password: "wrong-password-123",
        });
        assert.equal(wrongPassword.status, 401);
        assert.equal(absent.status, 401);
        assert.deepEqual(await wrongPassword.json(), await absent.json());
        const malformed = await request("/auth/register", {
          method: "POST",
          headers: {
            Origin: config.webOrigin,
            "Content-Type": "application/json",
          },
          body: "{",
        });
        assert.equal(malformed.status, 400);
        assert.deepEqual(await malformed.json(), {
          error: { code: "INVALID_JSON", message: "Send a valid JSON object." },
        });
        assert.equal(
          (
            await post("/auth/register", {
              email: "x".repeat(18000),
              password: demoPassword,
            })
          ).status,
          413,
        );
        assert.equal(
          (
            await request("/auth/login", {
              method: "POST",
              headers: {
                Origin: config.webOrigin,
                "Content-Type": "text/plain",
              },
              body: "hello",
            })
          ).status,
          415,
        );
      },
    );

    await suite.test(
      "missing, malformed, expired, forged and wrong-claim JWTs fail",
      async () => {
        const token = (
          overrides: {
            expiration?: number;
            issuer?: string;
            audience?: string;
            subject?: string;
            algorithm?: string;
            key?: Uint8Array;
            omitExpiry?: boolean;
          } = {},
        ) => {
          let builder = new SignJWT({})
            .setProtectedHeader({
              alg: overrides.algorithm ?? "HS256",
              typ: "JWT",
            })
            .setSubject(overrides.subject ?? fixtureId("alpha"))
            .setIssuer(overrides.issuer ?? tokenIssuer)
            .setAudience(overrides.audience ?? tokenAudience)
            .setIssuedAt();
          if (!overrides.omitExpiry)
            builder = builder.setExpirationTime(
              overrides.expiration ?? Math.floor(Date.now() / 1000) + 3600,
            );
          return builder.sign(overrides.key ?? config.secret);
        };
        const rejected = [
          "bad-token",
          await token({ expiration: Math.floor(Date.now() / 1000) - 1 }),
          await token({
            key: new TextEncoder().encode(
              "wrong-key-32-bytes-long-for-testing",
            ),
          }),
          await token({ issuer: "wrong" }),
          await token({ audience: "wrong" }),
          await token({ subject: "not-a-uuid" }),
          await token({ subject: randomUUID() }),
          await token({ algorithm: "HS384" }),
          await token({ omitExpiry: true }),
        ];
        assert.equal((await request("/auth/me")).status, 401);
        for (const jwt of rejected)
          assert.equal(
            (
              await request("/auth/me", {
                headers: { Cookie: `${sessionCookieName}=${jwt}` },
              })
            ).status,
            401,
          );
      },
    );

    await suite.test(
      "owner-scoped list/detail hide other owners and archived forms",
      async () => {
        assert.equal((await request("/forms")).status, 401);
        const listing = await request(`/forms?owner_id=${fixtureId("beta")}`, {
          headers: { Cookie: alphaCookie },
        });
        const body = await listing.json();
        assert.ok(
          typeof body === "object" &&
            body !== null &&
            "forms" in body &&
            Array.isArray(body.forms),
        );
        assert.deepEqual(
          body.forms
            .map((form: unknown) => {
              assert.ok(
                typeof form === "object" &&
                  form !== null &&
                  "id" in form &&
                  typeof form.id === "string",
              );
              return form.id;
            })
            .sort(),
          [fixtureId("survey"), fixtureId("draft")].sort(),
        );
        const own = await request(`/forms/${fixtureId("survey")}`, {
          headers: { Cookie: alphaCookie },
        });
        assert.equal(own.status, 200);
        const forbidden = await request(`/forms/${fixtureId("survey")}`, {
          headers: { Cookie: betaCookie },
        });
        const absent = await request(`/forms/${randomUUID()}`, {
          headers: { Cookie: betaCookie },
        });
        assert.equal(forbidden.status, 404);
        assert.deepEqual(await forbidden.json(), await absent.json());
        assert.equal(
          (
            await request(`/forms/${fixtureId("draft")}`, {
              headers: { Cookie: betaCookie },
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await request(`/forms/${fixtureId("archived")}`, {
              headers: { Cookie: betaCookie },
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await request("/forms/not-a-uuid", {
              headers: { Cookie: betaCookie },
            })
          ).status,
          404,
        );
        assert.equal((await request("/health")).status, 200);
      },
    );

    await suite.test(
      "cross-origin mutations fail and logout clears the cookie",
      async () => {
        for (const origin of ["https://attacker.example", "null", ""]) {
          const result = await request("/auth/logout", {
            method: "POST",
            headers: { Origin: origin, Cookie: alphaCookie },
          });
          assert.equal(result.status, 403);
        }
        const logout = await request("/auth/logout", {
          method: "POST",
          headers: { Origin: config.webOrigin, Cookie: alphaCookie },
        });
        assert.equal(logout.status, 204);
        assert.match(logout.headers.get("set-cookie") ?? "", /forms_session=;/);
        assert.equal((await request("/auth/me")).status, 401);
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.query("ROLLBACK");
    await pool.end();
  }
});
