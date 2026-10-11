import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../src/app.js";
import { readAuthConfig } from "../src/auth.js";
import { createDatabasePool } from "../src/database.js";
import { fixtureId, seedFixtures, demoPassword } from "../scripts/fixtures.js";
import { parseDraft } from "../src/contracts/draft.js";
import { archiveForm, saveDraft } from "../src/form-drafts.js";
import { publishForm, unpublishForm } from "../src/publication.js";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function entries(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

test("owner response reads preserve history and access boundaries", async (suite) => {
  const schema = `owned_responses_test_${randomUUID().replaceAll("-", "")}`;
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
  const path = `/forms/${formId}/responses`;
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
    const historicalResponses = await pool.query<{ id: string }>(
      "SELECT r.id FROM responses r JOIN form_versions v ON v.id=r.form_version_id WHERE v.form_id=$1 ORDER BY v.version_number,r.id",
      [formId],
    );
    const responseId = historicalResponses.rows[0]?.id;
    assert.ok(responseId);
    const detailPath = `${path}/${responseId}`;

    await suite.test(
      "list is ordered, version-aware and no-store; inaccessible IDs never disclose data",
      async () => {
        const result = await get(path, alpha);
        assert.equal(result.status, 200);
        assert.equal(result.headers.get("cache-control"), "no-store");
        const listing = record(await result.json());
        assert.equal(listing.total, 6);
        assert.equal(listing.pageSize, 50);
        const responses = entries(listing.responses);
        assert.deepEqual(
          responses.map((response) => response.id),
          (
            await pool.query(
              "SELECT r.id FROM responses r JOIN form_versions v ON v.id=r.form_version_id WHERE v.form_id=$1 ORDER BY r.submitted_at DESC,r.id DESC",
              [formId],
            )
          ).rows.map((row) => row.id),
        );
        assert.deepEqual(
          new Set(responses.map((response) => response.versionNumber)),
          new Set([1, 2]),
        );
        for (const response of responses)
          assert.deepEqual(Object.keys(response).sort(), [
            "email",
            "id",
            "submittedAt",
            "versionNumber",
          ]);
        for (const url of [path, detailPath]) {
          assert.equal((await get(url)).status, 401);
          const denied = await get(url, beta);
          assert.equal(denied.status, 404);
          assert.equal(denied.headers.get("cache-control"), "no-store");
        }
        for (const url of [
          `/forms/${fixtureId("draft")}/responses/${responseId}`,
          `/forms/${fixtureId("acknowledgment")}/responses/${responseId}`,
          `${path}/${randomUUID()}`,
          `${path}/not-a-uuid`,
          `/forms/${randomUUID()}/responses`,
          "/forms/not-a-uuid/responses",
        ])
          assert.equal((await get(url, alpha)).status, 404);
      },
    );
    await suite.test(
      "every stored type renders original labels, order, selections and date-only strings",
      async () => {
        const types = new Set<string>();
        for (const response of historicalResponses.rows) {
          const result = await get(`${path}/${response.id}`, alpha);
          assert.equal(result.status, 200);
          assert.equal(result.headers.get("cache-control"), "no-store");
          const detail = record(record(await result.json()).response);
          assert.deepEqual(Object.keys(detail).sort(), [
            "answers",
            "description",
            "email",
            "formVersionId",
            "id",
            "submittedAt",
            "title",
            "versionNumber",
          ]);
          const expected = await pool.query(
            "SELECT q.id,q.label,q.type,a.id AS answer_id,COALESCE(a.text_value,a.date_value::text,a.integer_value::text) AS value FROM responses r JOIN version_questions q ON q.form_version_id=r.form_version_id LEFT JOIN answers a ON a.response_id=r.id AND a.question_id=q.id WHERE r.id=$1 ORDER BY q.position",
            [response.id],
          );
          const answers = entries(detail.answers);
          assert.equal(answers.length, 8);
          for (const [index, question] of expected.rows.entries()) {
            types.add(question.type);
            const answer = answers[index];
            assert.ok(answer);
            assert.equal(answer.questionId, question.id);
            assert.equal(answer.label, question.label);
            assert.equal(answer.value, question.value);
            assert.deepEqual(Object.keys(answer).sort(), [
              "label",
              "questionId",
              "selectedOptions",
              "value",
            ]);
            if (question.type === "date" && answer.value !== null)
              assert.match(String(answer.value), /^\d{4}-\d{2}-\d{2}$/);
            const selections = await pool.query(
              "SELECT o.id,o.label FROM answer_selections s JOIN question_options o ON o.id=s.option_id WHERE s.answer_id=$1 ORDER BY s.selection_position",
              [question.answer_id],
            );
            assert.deepEqual(answer.selectedOptions, selections.rows);
          }
        }
        assert.equal(types.size, 8);
      },
    );
    await suite.test(
      "draft edits and a new publication cannot rewrite old response detail; unpublish keeps owner access",
      async () => {
        const before = await (await get(detailPath, alpha)).json();
        const draft = parseDraft(
          (
            await pool.query(
              "SELECT definition FROM form_drafts WHERE form_id=$1",
              [formId],
            )
          ).rows[0].definition,
        );
        draft.title = "Changed title";
        draft.questions = draft.questions
          .slice(0, 5)
          .reverse()
          .map((question) => {
            if ("options" in question)
              return {
                ...question,
                label: `Changed ${question.label}`,
                options: question.options.map((option, index) => ({
                  ...option,
                  label: `Changed choice ${index}`,
                })),
              };
            return { ...question, label: `Changed ${question.label}` };
          });
        await saveDraft(pool, fixtureId("alpha"), formId, draft);
        await publishForm(
          pool,
          fixtureId("alpha"),
          formId,
          randomUUID(),
          draft,
        );
        assert.deepEqual(await (await get(detailPath, alpha)).json(), before);
        await unpublishForm(pool, fixtureId("alpha"), formId);
        assert.equal((await get(path, alpha)).status, 200);
        assert.deepEqual(await (await get(detailPath, alpha)).json(), before);
      },
    );
    await suite.test(
      "empty draft/published forms return an empty list; missing answers remain in detail",
      async () => {
        for (const [id, cookie] of [
          [fixtureId("draft"), alpha],
          [fixtureId("acknowledgment"), beta],
        ]) {
          const result = await get(`/forms/${id}/responses`, cookie);
          assert.equal(result.status, 200);
          const body = record(await result.json());
          assert.equal(body.total, 0);
          assert.deepEqual(body.responses, []);
        }
        const removed = await pool.query<{ question_id: string }>(
          "DELETE FROM answers WHERE response_id=$1 AND question_type='date' RETURNING question_id",
          [responseId],
        );
        assert.equal(removed.rowCount, 1);
        const detail = record(
          record(await (await get(detailPath, alpha)).json()).response,
        );
        const answer = entries(detail.answers).find(
          (answer) => answer.questionId === removed.rows[0]?.question_id,
        );
        assert.ok(answer);
        assert.equal(answer.value, null);
        assert.deepEqual(answer.selectedOptions, []);
      },
    );
    await suite.test(
      "pagination is bounded and deterministic with tied timestamps; invalid pages fail",
      async () => {
        const version = (
          await pool.query("SELECT current_version_id FROM forms WHERE id=$1", [
            formId,
          ])
        ).rows[0].current_version_id;
        await pool.query(
          "INSERT INTO responses(form_version_id,email,submitted_at) SELECT $1,'page-'||n||'@example.test','2030-01-01T00:00:00Z' FROM generate_series(1,55) n",
          [version],
        );
        const first = record(await (await get(path, alpha)).json());
        const second = record(
          await (await get(`${path}?page=1`, alpha)).json(),
        );
        assert.equal(first.total, 61);
        assert.equal(entries(first.responses).length, 50);
        assert.equal(entries(second.responses).length, 11);
        const combined = [
          ...entries(first.responses),
          ...entries(second.responses),
        ].map((response) => response.id);
        assert.equal(new Set(combined).size, 61);
        assert.deepEqual(
          combined,
          (
            await pool.query(
              "SELECT r.id FROM responses r JOIN form_versions v ON v.id=r.form_version_id WHERE v.form_id=$1 ORDER BY r.submitted_at DESC,r.id DESC",
              [formId],
            )
          ).rows.map((row) => row.id),
        );
        assert.deepEqual(
          record(await (await get(`${path}?page=2`, alpha)).json()).responses,
          [],
        );
        for (const page of ["-1", "1.5", "word", "99999999", "0&page=1"])
          assert.equal((await get(`${path}?page=${page}`, alpha)).status, 400);
      },
    );
    await suite.test(
      "archiving hides every response route and retains stored rows",
      async () => {
        const before = (
          await pool.query("SELECT count(*)::int AS count FROM responses")
        ).rows[0].count;
        await archiveForm(pool, fixtureId("alpha"), formId);
        assert.equal((await get(path, alpha)).status, 404);
        assert.equal((await get(detailPath, alpha)).status, 404);
        const archivedId = fixtureId("archived");
        const historical = (
          await pool.query(
            "SELECT r.id FROM responses r JOIN form_versions v ON v.id=r.form_version_id WHERE v.form_id=$1",
            [archivedId],
          )
        ).rows[0].id;
        assert.equal(
          (await get(`/forms/${archivedId}/responses`, beta)).status,
          404,
        );
        assert.equal(
          (await get(`/forms/${archivedId}/responses/${historical}`, beta))
            .status,
          404,
        );
        assert.equal(
          (await pool.query("SELECT count(*)::int AS count FROM responses"))
            .rows[0].count,
          before,
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
