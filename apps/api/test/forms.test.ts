import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../src/app.js";
import { readAuthConfig } from "../src/auth.js";
import { createDatabasePool } from "../src/database.js";
import {
  changeQuestionType,
  parseDraft,
  questionTypes,
} from "../src/contracts/draft.js";
import { demoPassword, fixtureId, seedFixtures } from "../scripts/fixtures.js";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function readDefinition(response: Response) {
  assert.equal(response.status, 200);
  return parseDraft(object(await response.json()).definition);
}

test("draft contract accepts incomplete content and clears incompatible configuration", () => {
  const question = {
    id: randomUUID(),
    label: "",
    required: false,
    type: "checkboxes" as const,
    options: [{ id: randomUUID(), label: "" }],
  };
  for (const type of questionTypes) {
    const changed = changeQuestionType(question, type);
    assert.equal(changed.id, question.id);
    assert.deepEqual(
      parseDraft({ title: "", description: null, questions: [changed] })
        .questions[0],
      changed,
    );
    if ("options" in changed) assert.equal(changed.options.length, 0);
    else assert.equal("options" in changed, false);
  }
  assert.throws(
    () =>
      parseDraft({
        title: "",
        description: null,
        questions: [question, question],
      }),
    /distinct/,
  );
});

test("draft lifecycle over HTTP with real PostgreSQL", async (suite) => {
  // Committed test-only schema permits genuine multi-connection transactions.
  // Never alter/reset the developer's application schema or fixture records.
  const schema = `forms_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabasePool();
  const pool = createDatabasePool();
  pool.options.options = `-c search_path=${schema}`;
  const config = readAuthConfig({
    JWT_SECRET: "forms-test-key-only-at-least-thirty-two-bytes",
    WEB_ORIGIN: "http://localhost:3000",
  });
  const server = createApp(pool, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, method = "GET", cookie = "", body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: config.webOrigin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function login(email: string) {
    const response = await request("/auth/login", "POST", "", {
      email,
      password: demoPassword,
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    return cookie;
  }
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
    const surveyId = fixtureId("survey");
    const definition = await readDefinition(
      await request(`/forms/${surveyId}/draft`, "GET", alpha),
    );
    const publishedBefore = (
      await pool.query(
        "SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS snapshot FROM version_questions q",
      )
    ).rows[0].snapshot;

    await suite.test(
      "creation derives ownership from session and is atomic",
      async () => {
        const created = await request("/forms", "POST", alpha, {
          owner_id: fixtureId("beta"),
          is_published: true,
        });
        assert.equal(created.status, 201);
        const id = object(object(await created.json()).form).id;
        assert.equal(typeof id, "string");
        const row = (
          await pool.query(
            "SELECT owner_id,is_published FROM forms WHERE id=$1",
            [id],
          )
        ).rows[0];
        assert.equal(row.owner_id, fixtureId("alpha"));
        assert.equal(row.is_published, false);
        assert.deepEqual(
          await readDefinition(
            await request(`/forms/${id}/draft`, "GET", alpha),
          ),
          { title: "", description: null, questions: [] },
        );
        const count = (await pool.query("SELECT count(*) FROM forms")).rows[0]
          .count;
        await pool.query(
          "CREATE FUNCTION reject_test_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test draft failure'; END $$; CREATE TRIGGER reject_test_draft BEFORE INSERT ON form_drafts FOR EACH ROW EXECUTE FUNCTION reject_test_draft()",
        );
        try {
          assert.equal((await request("/forms", "POST", alpha)).status, 500);
        } finally {
          await pool.query(
            "DROP TRIGGER reject_test_draft ON form_drafts; DROP FUNCTION reject_test_draft()",
          );
        }
        assert.equal(
          (await pool.query("SELECT count(*) FROM forms")).rows[0].count,
          count,
        );
      },
    );
    await suite.test(
      "owner-only draft reads, writes and archive; unknown IDs do not disclose forms",
      async () => {
        assert.equal((await request("/forms", "POST")).status, 401);
        for (const [path, method] of [
          [`/forms/${surveyId}/draft`, "GET"],
          [`/forms/${surveyId}/draft`, "PUT"],
          [`/forms/${surveyId}`, "DELETE"],
        ]) {
          assert.ok(path && method);
          assert.equal(
            (
              await request(
                path,
                method,
                "",
                method === "PUT" ? definition : undefined,
              )
            ).status,
            401,
          );
          assert.equal(
            (
              await request(
                path,
                method,
                beta,
                method === "PUT" ? definition : undefined,
              )
            ).status,
            404,
          );
        }
        assert.equal(
          (await request(`/forms/${randomUUID()}/draft`, "GET", alpha)).status,
          404,
        );
        assert.equal(
          (await request("/forms/not-a-uuid/draft", "GET", alpha)).status,
          404,
        );
        for (const method of ["POST", "PUT", "DELETE"]) {
          const path =
            method === "POST"
              ? "/forms"
              : `/forms/${surveyId}${method === "PUT" ? "/draft" : ""}`;
          const result = await fetch(`${base}${path}`, {
            method,
            headers: {
              Cookie: alpha,
              Origin: "http://malicious-site.com",
              "Content-Type": "application/json",
            },
            ...(method === "PUT" ? { body: JSON.stringify(definition) } : {}),
          });
          assert.equal(result.status, 403);
        }
      },
    );
    await suite.test(
      "all eight types round-trip, incomplete content saves, reorder retains IDs and history",
      async () => {
        assert.equal(definition.questions.length, 8);
        const edited = {
          ...definition,
          title: "",
          questions: [...definition.questions]
            .reverse()
            .map((question) => ({ ...question, label: "" })),
        };
        assert.equal(
          (await request(`/forms/${surveyId}/draft`, "PUT", alpha, edited))
            .status,
          204,
        );
        assert.deepEqual(
          await readDefinition(
            await request(`/forms/${surveyId}/draft`, "GET", alpha),
          ),
          edited,
        );
        assert.deepEqual(
          (
            await pool.query(
              "SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS snapshot FROM version_questions q",
            )
          ).rows[0].snapshot,
          publishedBefore,
        );
        for (const invalid of [
          { ...edited, questions: [edited.questions[0], edited.questions[0]] },
          {
            ...edited,
            questions: [
              { id: randomUUID(), type: "unknown", label: "", required: false },
            ],
          },
          { ...edited, title: 123 },
        ]) {
          assert.equal(
            (await request(`/forms/${surveyId}/draft`, "PUT", alpha, invalid))
              .status,
            400,
          );
        }
        assert.deepEqual(
          await readDefinition(
            await request(`/forms/${surveyId}/draft`, "GET", alpha),
          ),
          edited,
        );
      },
    );
    await suite.test(
      "archive coordinates with a waiting save and retains every historical row",
      async () => {
        const before = (
          await pool.query(
            "SELECT (SELECT count(*) FROM responses) AS responses,(SELECT count(*) FROM form_versions) AS versions,(SELECT count(*) FROM answers) AS answers",
          )
        ).rows[0];
        const blocker = await pool.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "UPDATE forms SET deleted_at=now(),is_published=false WHERE id=$1",
            [surveyId],
          );
          const pending = request(
            `/forms/${surveyId}/draft`,
            "PUT",
            alpha,
            definition,
          );
          // Observe the save actually waiting on the root lock before committing archive.
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const result = await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE application_name='forms-api' AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM forms WHERE id=%'",
            );
            if (result.rowCount) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await blocker.query("COMMIT");
          assert.equal((await pending).status, 404);
          assert.ok(waiting, "save was observed waiting for archive lock");
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
        for (const suffix of ["", "/draft"])
          assert.equal(
            (await request(`/forms/${surveyId}${suffix}`, "GET", alpha)).status,
            404,
          );
        assert.equal(
          (await request(`/forms/${surveyId}`, "DELETE", alpha)).status,
          404,
        );
        const draftId = fixtureId("draft");
        assert.equal(
          (await request(`/forms/${draftId}`, "DELETE", alpha)).status,
          204,
        );
        assert.equal(
          (await request(`/forms/${draftId}/draft`, "GET", alpha)).status,
          404,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM form_drafts WHERE form_id=$1",
              [draftId],
            )
          ).rows[0].count,
          1,
        );
        assert.deepEqual(
          (
            await pool.query(
              "SELECT (SELECT count(*) FROM responses) AS responses,(SELECT count(*) FROM form_versions) AS versions,(SELECT count(*) FROM answers) AS answers",
            )
          ).rows[0],
          before,
        );
        assert.deepEqual(
          (
            await pool.query(
              "SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS snapshot FROM version_questions q",
            )
          ).rows[0].snapshot,
          publishedBefore,
        );
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
