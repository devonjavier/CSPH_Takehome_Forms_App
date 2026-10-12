import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../src/app.js";
import { readAuthConfig } from "../src/auth.js";
import { createDatabasePool } from "../src/database.js";
import { parseDraft, type DraftDefinition } from "../src/contracts/draft.js";
import { validatePublication } from "../src/contracts/publication.js";
import { seedFixtures, fixtureId, demoPassword } from "../scripts/fixtures.js";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const textQuestion = {
  id: randomUUID(),
  type: "short_text" as const,
  required: false,
  label: "Name",
};
const simple: DraftDefinition = {
  title: "Title",
  description: null,
  questions: [textQuestion],
};
test("whole-definition publication rules", () => {
  for (const invalid of [
    { ...simple, title: " \n\t" },
    { ...simple, questions: [] },
    { ...simple, questions: [{ ...textQuestion, label: "\t" }] },
  ])
    assert.throws(() => validatePublication(invalid));
  for (const type of [
    "dropdown",
    "multi_select",
    "multiple_choice",
    "checkboxes",
  ] as const) {
    const one = {
      ...textQuestion,
      type,
      options: [{ id: randomUUID(), label: "Yes" }],
    };
    assert.doesNotThrow(() =>
      validatePublication({ ...simple, questions: [one] }),
    );
    const required = { ...one, required: true };
    if (type === "checkboxes")
      assert.doesNotThrow(() =>
        validatePublication({ ...simple, questions: [required] }),
      );
    else
      assert.throws(
        () => validatePublication({ ...simple, questions: [required] }),
        /at least 2/,
      );
    for (const labels of [[], [" "], ["Yes", " Yes\t"]]) {
      assert.throws(() =>
        validatePublication({
          ...simple,
          questions: [
            {
              ...one,
              options: labels.map((label) => ({ id: randomUUID(), label })),
            },
          ],
        }),
      );
    }
    assert.doesNotThrow(() =>
      validatePublication({
        ...simple,
        questions: [
          {
            ...required,
            options: ["Yes", "yes"].map((label) => ({
              id: randomUUID(),
              label,
            })),
          },
        ],
      }),
    );
  }
  for (const [min, max] of [
    [null, 5],
    [5, 5],
    [10, 1],
    [1.5, 5],
  ])
    assert.throws(() =>
      validatePublication({
        ...simple,
        questions: [{ ...textQuestion, type: "linear_scale", min, max }],
      }),
    );
  assert.doesNotThrow(() =>
    validatePublication({
      ...simple,
      questions: [textQuestion, { ...textQuestion, id: randomUUID() }],
    }),
  );
});

test("publication transactions and public visibility in PostgreSQL", async (suite) => {
  const schema = `publication_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabasePool();
  const pool = createDatabasePool();
  pool.options.options = `-c search_path=${schema}`;
  const config = readAuthConfig({
    JWT_SECRET: "publication-test-secret-at-least-32-bytes",
    WEB_ORIGIN: "http://localhost:3000",
  });
  const server = createApp(pool, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = async (
    path: string,
    method = "GET",
    cookie = "",
    body?: unknown,
    expectedETag?: string,
  ): Promise<Response> => {
    const etag =
      expectedETag ??
      (method === "PUT" && path.endsWith("/draft")
        ? ((await request(path, "GET", cookie)).headers.get("etag") ?? "")
        : "");
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: config.webOrigin,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
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
  const surveyId = fixtureId("survey");
  async function versionCount() {
    return (
      await pool.query(
        "SELECT count(*)::int AS count FROM form_versions WHERE form_id=$1",
        [surveyId],
      )
    ).rows[0].count;
  }
  async function current() {
    return (
      await pool.query(
        "SELECT current_version_id,is_published FROM forms WHERE id=$1",
        [surveyId],
      )
    ).rows[0];
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
        .filter((file) => file === "001_initial_schema.sql")
        .sort())
        await client.query(await readFile(new URL(file, directory), "utf8"));
      await seedFixtures(client);
      await client.query("COMMIT");
      // Exercise upgrading already-committed historical data, not just a fresh DB.
      await client.query("BEGIN");
      for (const file of (await readdir(directory))
        .filter(
          (file) =>
            /^\d{3}_.*\.sql$/.test(file) && file !== "001_initial_schema.sql",
        )
        .sort())
        await client.query(await readFile(new URL(file, directory), "utf8"));
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const alpha = await login("owner.alpha@example.test");
    const beta = await login("owner.beta@example.test");
    await suite.test(
      "multiple selections at Excel's limit publish, submit and export without loss",
      async () => {
        for (const type of ["multi_select", "checkboxes"] as const) {
          const form = record(
            record(await (await request("/forms", "POST", alpha)).json()).form,
          );
          const formId = String(form.id);
          const definition: DraftDefinition = {
            title: "Export boundary",
            description: null,
            questions: [
              {
                id: randomUUID(),
                type,
                label: "All choices",
                required: true,
                options: Array.from({ length: 40 }, (_, i) => ({
                  id: randomUUID(),
                  label: String(i).padStart(3, "0") + "x".repeat(997),
                })),
              },
            ],
          };
          assert.equal(
            (await request(`/forms/${formId}/draft`, "PUT", alpha, definition))
              .status,
            200,
          );
          const publish = () =>
            request(`/forms/${formId}/publish`, "POST", alpha, {
              publicationActionId: randomUUID(),
              definition,
            });
          assert.equal((await publish()).status, 400);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM form_versions WHERE form_id=$1",
                [formId],
              )
            ).rows[0].count,
            0,
          );
          const question = definition.questions[0];
          assert.ok(question && "options" in question);
          question.options = question.options.slice(0, 33);
          const last = question.options[32];
          assert.ok(last);
          last.label = last.label.slice(0, 735);
          const expected = question.options.map((o) => o.label).join("\n");
          assert.equal(expected.length, 32767);
          assert.equal(
            (await request(`/forms/${formId}/draft`, "PUT", alpha, definition))
              .status,
            200,
          );
          assert.equal((await publish()).status, 201);
          const metadata = record(
            record(
              await (await request(`/forms/${formId}`, "GET", alpha)).json(),
            ).form,
          );
          const publicResult = record(
            await (await request(`/public/forms/${metadata.slug}`)).json(),
          );
          const published = record(publicResult.form);
          const questions = published.questions;
          assert.ok(Array.isArray(questions));
          const publishedQuestion = record(questions[0]);
          const options = publishedQuestion.options;
          assert.ok(Array.isArray(options));
          const submission = await request(
            `/public/forms/${metadata.slug}/responses`,
            "POST",
            "",
            {
              formVersionId: published.formVersionId,
              email: "boundary@example.test",
              answers: [
                {
                  questionId: publishedQuestion.id,
                  value: options.map((o) => record(o).id),
                },
              ],
            },
          );
          assert.equal(submission.status, 201);
          const exported = await request(
            `/forms/${formId}/responses/export`,
            "GET",
            alpha,
          );
          assert.equal(exported.status, 200);
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(await exported.arrayBuffer());
          assert.equal(
            workbook.getWorksheet("Version 1")?.getCell("C2").value,
            expected,
          );
        }
      },
    );
    await suite.test(
      "committed versions reject appended questions and options",
      async () => {
        const versions = await pool.query(
          "SELECT DISTINCT ON (build_transaction IS NULL) id FROM form_versions ORDER BY (build_transaction IS NULL),id",
        );
        assert.equal(versions.rowCount, 2); // Legacy and newly published versions.
        for (const version of versions.rows)
          await assert.rejects(
            pool.query(
              "INSERT INTO version_questions(form_version_id,label,type,position,required) VALUES($1,'Injected','short_text',999,false)",
              [version.id],
            ),
            /sealed/,
          );
        const question = (
          await pool.query(
            "SELECT id,type FROM version_questions WHERE type='dropdown' LIMIT 1",
          )
        ).rows[0];
        await assert.rejects(
          pool.query(
            "INSERT INTO question_options(question_id,question_type,label,position) VALUES($1,$2,'Injected',999)",
            [question.id, question.type],
          ),
          /sealed/,
        );
      },
    );
    await suite.test(
      "a draft at the save body limit remains publishable",
      async () => {
        const created = record(
          await (await request("/forms", "POST", alpha)).json(),
        );
        const formId = String(record(created.form).id);
        const definition: DraftDefinition = {
          title: "Boundary size",
          description: "",
          questions: Array.from({ length: 3 }, () => ({
            id: randomUUID(),
            type: "dropdown",
            label: "Choose",
            required: false,
            options: Array.from({ length: 80 }, (_, index) => ({
              id: randomUUID(),
              label: String(index).padStart(4, "0") + "x".repeat(996),
            })),
          })),
        };
        const padding =
          256 * 1024 - 1 - Buffer.byteLength(JSON.stringify(definition));
        assert.ok(padding > 0 && padding <= 10000);
        definition.description = "x".repeat(padding);
        assert.equal(
          (await request(`/forms/${formId}/draft`, "PUT", alpha, definition))
            .status,
          200,
        );
        const publication = { publicationActionId: randomUUID(), definition };
        assert.ok(Buffer.byteLength(JSON.stringify(publication)) > 256 * 1024);
        assert.equal(
          (
            await request(
              `/forms/${formId}/publish`,
              "POST",
              alpha,
              publication,
            )
          ).status,
          201,
        );
      },
    );
    const draft = parseDraft(
      record(
        await (await request(`/forms/${surveyId}/draft`, "GET", alpha)).json(),
      ).definition,
    );
    const action = { publicationActionId: randomUUID(), definition: draft };
    const publish = (body: unknown = action, cookie = alpha) =>
      request(`/forms/${surveyId}/publish`, "POST", cookie, body);
    const historical = (
      await pool.query(
        "SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS snapshot FROM version_questions q",
      )
    ).rows[0].snapshot;

    await suite.test(
      "owner/auth/origin/action validation and unpublished visibility",
      async () => {
        assert.equal((await publish(action, "")).status, 401);
        assert.equal((await publish(action, beta)).status, 404);
        assert.equal(
          (await publish({ ...action, publicationActionId: "bad" })).status,
          400,
        );
        assert.equal(
          (await request(`/forms/${surveyId}/unpublish`, "POST", beta)).status,
          404,
        );
        assert.equal(
          (await request(`/forms/${surveyId}/publication`, "GET", beta)).status,
          404,
        );
        for (const slug of ["demo-draft", "demo-archived", "missing"])
          assert.equal((await request(`/public/forms/${slug}`)).status, 404);
        const response = await fetch(
          `http://127.0.0.1:${address.port}/forms/${surveyId}/publish`,
          {
            method: "POST",
            headers: { Cookie: alpha, "Content-Type": "application/json" },
            body: JSON.stringify(action),
          },
        );
        assert.equal(response.status, 403);
      },
    );
    await suite.test(
      "concurrent duplicate publish creates one complete eight-type version",
      async () => {
        const responses = await Promise.all([publish(), publish()]);
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [200, 201],
        );
        const first = record(record(await responses[0]?.json()).publication);
        const second = record(record(await responses[1]?.json()).publication);
        assert.equal(first.id, second.id);
        assert.equal(first.versionNumber, 3);
        assert.equal(await versionCount(), 3);
        const publicResponse = await request("/public/forms/demo-survey");
        assert.equal(publicResponse.status, 200);
        assert.equal(publicResponse.headers.get("cache-control"), "no-store");
        const form = record(record(await publicResponse.json()).form);
        assert.deepEqual(Object.keys(form).sort(), [
          "description",
          "formVersionId",
          "questions",
          "title",
          "versionNumber",
        ]);
        assert.equal(form.formVersionId, first.id);
        assert.equal(form.title, draft.title);
        assert.ok(Array.isArray(form.questions));
        assert.equal(form.questions.length, 8);
        for (const [index, value] of form.questions.entries()) {
          const question = record(value);
          const expected = draft.questions[index];
          assert.ok(expected);
          assert.deepEqual(Object.keys(question).sort(), [
            "id",
            "label",
            "max",
            "maxLabel",
            "min",
            "minLabel",
            "options",
            "position",
            "required",
            "type",
          ]);
          assert.equal(question.type, expected.type);
          assert.equal(question.label, expected.label);
          assert.equal(question.position, index);
          assert.notEqual(question.id, expected.id);
          if ("options" in expected) {
            assert.ok(Array.isArray(question.options));
            for (const [optionIndex, value] of question.options.entries()) {
              const option = record(value);
              assert.deepEqual(Object.keys(option).sort(), [
                "id",
                "label",
                "position",
              ]);
              assert.equal(option.position, optionIndex);
              assert.notEqual(option.id, expected.options[optionIndex]?.id);
            }
            assert.deepEqual(
              question.options.map((value) => record(value).label),
              expected.options.map((option) => option.label.trim()),
            );
          }
        }
        assert.equal("owner_id" in form, false);
        assert.equal("definition" in form, false);
      },
    );
    await suite.test(
      "new confirmations create new versions; old replay never rewinds or republishes",
      async () => {
        const results = await Promise.all([
          publish({ ...action, publicationActionId: randomUUID() }),
          publish({ ...action, publicationActionId: randomUUID() }),
        ]);
        assert.deepEqual(
          results.map((response) => response.status),
          [201, 201],
        );
        assert.equal(await versionCount(), 5);
        const before = await current();
        assert.equal((await publish()).status, 200);
        assert.deepEqual(await current(), before);
        assert.equal(
          (await request(`/forms/${surveyId}/unpublish`, "POST", alpha)).status,
          204,
        );
        assert.equal((await request("/public/forms/demo-survey")).status, 404);
        assert.equal((await publish()).status, 200);
        assert.equal((await current()).is_published, false);
        assert.equal(
          (await current()).current_version_id,
          before.current_version_id,
        );
        assert.equal(
          (await request(`/forms/${surveyId}/draft`, "GET", alpha)).status,
          200,
        );
        assert.equal(
          (await publish({ ...action, publicationActionId: randomUUID() }))
            .status,
          201,
        );
        assert.equal(await versionCount(), 6);
        assert.equal((await request("/public/forms/demo-survey")).status, 200);
      },
    );
    await suite.test(
      "invalid or changed drafts cannot publish; draft edits do not leak publicly",
      async () => {
        const invalid = { ...draft, title: "", questions: [] };
        assert.equal(
          (await request(`/forms/${surveyId}/draft`, "PUT", alpha, invalid))
            .status,
          200,
        );
        const changed = await publish({
          ...action,
          publicationActionId: randomUUID(),
        });
        assert.equal(changed.status, 409);
        assert.equal(
          record(record(await changed.json()).error).code,
          "DRAFT_CHANGED",
        );
        assert.equal(
          (
            await publish({
              publicationActionId: randomUUID(),
              definition: invalid,
            })
          ).status,
          400,
        );
        assert.equal(await versionCount(), 6);
        const publicForm = record(
          record(await (await request("/public/forms/demo-survey")).json())
            .form,
        );
        assert.equal(publicForm.title, draft.title);
        assert.equal((await publish()).status, 200);
        assert.equal(
          (await request(`/forms/${surveyId}/draft`, "PUT", alpha, draft))
            .status,
          200,
        );
      },
    );
    await suite.test(
      "failure mid-tree rolls back version, questions, options and pointer",
      async () => {
        const before = await current();
        const counts = (
          await pool.query(
            "SELECT (SELECT count(*) FROM version_questions) AS questions,(SELECT count(*) FROM question_options) AS options",
          )
        ).rows[0];
        await pool.query(
          "CREATE FUNCTION reject_publication_option() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_publication_option BEFORE INSERT ON question_options FOR EACH ROW EXECUTE FUNCTION reject_publication_option()",
        );
        try {
          assert.equal(
            (await publish({ ...action, publicationActionId: randomUUID() }))
              .status,
            500,
          );
        } finally {
          await pool.query(
            "DROP TRIGGER reject_publication_option ON question_options; DROP FUNCTION reject_publication_option()",
          );
        }
        assert.equal(await versionCount(), 6);
        assert.deepEqual(await current(), before);
        assert.deepEqual(
          (
            await pool.query(
              "SELECT (SELECT count(*) FROM version_questions) AS questions,(SELECT count(*) FROM question_options) AS options",
            )
          ).rows[0],
          counts,
        );
      },
    );
    await suite.test(
      "publish waits for archive and cannot reactivate it; original history retained",
      async () => {
        const responseCountBefore = (
          await pool.query("SELECT count(*)::int AS count FROM responses")
        ).rows[0].count;
        const blocker = await pool.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "UPDATE forms SET deleted_at=now(),is_published=false WHERE id=$1",
            [surveyId],
          );
          const pending = publish({
            ...action,
            publicationActionId: randomUUID(),
          });
          let waiting = false;
          for (let index = 0; index < 100; index++) {
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
          assert.ok(waiting);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
        assert.equal((await publish()).status, 404);
        for (const [path, method, body] of [
          [`/forms/${surveyId}`, "GET", undefined],
          [`/forms/${surveyId}/draft`, "GET", undefined],
          [`/forms/${surveyId}/draft`, "PUT", draft],
          [`/forms/${surveyId}/unpublish`, "POST", undefined],
          [`/forms/${surveyId}`, "DELETE", undefined],
        ] as const) {
          const response = await request(path, method, alpha, body);
          assert.equal(response.status, 404);
          assert.equal(
            record(record(await response.json()).error).code,
            "NOT_FOUND",
          );
        }
        const listing = record(
          await (await request("/forms", "GET", alpha)).json(),
        );
        assert.ok(Array.isArray(listing.forms));
        assert.equal(
          listing.forms.some((value) => record(value).id === surveyId),
          false,
        );
        assert.equal(
          (await request(`/forms/${surveyId}/publication`, "GET", alpha))
            .status,
          404,
        );
        const hidden = await request("/public/forms/demo-survey");
        assert.equal(hidden.status, 404);
        assert.equal(hidden.headers.get("cache-control"), "no-store");
        assert.equal(await versionCount(), 6);
        const original = (
          await pool.query(
            "SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) AS snapshot FROM version_questions q JOIN form_versions v ON v.id=q.form_version_id WHERE v.publication_action_id<>$1 AND (v.form_id<>$2 OR v.version_number<=2)",
            [action.publicationActionId, surveyId],
          )
        ).rows[0].snapshot;
        assert.deepEqual(original, historical);
        assert.equal(
          (await pool.query("SELECT count(*)::int AS count FROM responses"))
            .rows[0].count,
          responseCountBefore,
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
