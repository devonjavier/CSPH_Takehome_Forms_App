import { draftETag } from "../src/form-drafts.js";
import assert from "node:assert/strict";
import { drainWebhooks } from "../src/webhooks.js";
import { submitResponse } from "../src/responses.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../src/app.js";
import { readAuthConfig } from "../src/auth.js";
import { createDatabasePool } from "../src/database.js";
import {
  parseSubmission,
  validateAnswers,
  serializeSubmission,
  submissionBodyLimitBytes,
  SubmissionError,
  type Submission,
} from "../src/contracts/submission.js";
import {
  parseDraft,
  parsePublicForm,
  type PublicForm,
} from "../src/contracts/draft.js";
import {
  readPublicForm,
  validatePublicSlug,
} from "../src/public-definition.js";
import { publishForm, unpublishForm } from "../src/publication.js";
import { archiveForm, createDraft, saveDraft } from "../src/form-drafts.js";
import { fixtureId, seedFixtures } from "../scripts/fixtures.js";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
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

test("public slugs reject unsupported characters with a complete match", () => {
  for (const slug of [
    "",
    "\u0000",
    "demo-survey\n",
    "demo-survey\r",
    "Demo",
    "-demo",
    "demo-",
    "demo--survey",
    "demo/survey",
  ])
    assert.throws(() => validatePublicSlug(slug), /Form not found/);
  for (const slug of ["demo-survey", randomUUID()])
    assert.doesNotThrow(() => validatePublicSlug(slug));
});

test("submission preflight counts UTF-8 and JSON escaping at the exact byte boundary", () => {
  const definition = parseDraft({
    title: "Size",
    description: null,
    questions: Array.from({ length: 100 }, () => ({
      id: randomUUID(),
      type: "long_text",
      label: "Text",
      required: false,
    })),
  });
  const makeSubmission = (value: string): Submission => ({
    formVersionId: randomUUID(),
    email: "size@example.test",
    answers: definition.questions.map((q) => ({ questionId: q.id, value })),
  });
  const ascii = makeSubmission("a".repeat(10000));
  validateAnswers(definition, ascii);
  assert.equal(serializeSubmission(ascii), JSON.stringify(ascii));
  for (const character of ["界", "\u0001"]) {
    const oversized = makeSubmission(character.repeat(10000));
    validateAnswers(definition, oversized);
    const original = JSON.stringify(oversized);
    assert.throws(
      () => serializeSubmission(oversized),
      (error: unknown) =>
        error instanceof SubmissionError && error.field === "form",
    );
    assert.equal(JSON.stringify(oversized), original); // Preserve entered values.
    const boundary = makeSubmission("");
    const last = boundary.answers.at(-1);
    assert.ok(last);
    last.value = "aa";
    let remaining =
      submissionBodyLimitBytes - Buffer.byteLength(JSON.stringify(boundary));
    const unitBytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    for (const answer of boundary.answers.slice(0, -1)) {
      const units = Math.min(9999, Math.floor(remaining / unitBytes));
      answer.value = character.repeat(units);
      remaining -= units * unitBytes;
    }
    last.value = String(last.value) + "a".repeat(remaining);
    validateAnswers(definition, boundary);
    assert.equal(
      Buffer.byteLength(serializeSubmission(boundary)),
      submissionBodyLimitBytes,
    );
    last.value += "a";
    assert.throws(() => serializeSubmission(boundary), SubmissionError);
    last.value = String(last.value).slice(0, -2);
    assert.equal(
      Buffer.byteLength(serializeSubmission(boundary)),
      submissionBodyLimitBytes - 1,
    );
  }
});

test("public submissions validate and commit atomically in PostgreSQL", async (suite) => {
  const schema = `responses_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabasePool();
  const pool = createDatabasePool();
  pool.options.options = `-c search_path=${schema}`;
  const config = readAuthConfig({
    JWT_SECRET: "response-test-secret-at-least-32-bytes",
    WEB_ORIGIN: "http://localhost:3000",
  });
  const server = createApp(pool, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (
    body: unknown,
    slug = "demo-survey",
    origin: string | null = config.webOrigin,
    contentType = "application/json",
  ) =>
    fetch(`http://127.0.0.1:${address.port}/public/forms/${slug}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        ...(origin === null ? {} : { Origin: origin }),
      },
      body: JSON.stringify(body),
    });
  async function counts() {
    return (
      await pool.query(
        "SELECT (SELECT count(*) FROM responses) AS responses,(SELECT count(*) FROM answers) AS answers,(SELECT count(*) FROM answer_selections) AS selections",
      )
    ).rows[0];
  }
  async function waitForLock(queryPrefix: string) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const result = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name='forms-api' AND wait_event_type='Lock' AND query LIKE $1",
        [`${queryPrefix}%`],
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Expected a blocked transaction: ${queryPrefix}`);
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
        .filter((file) => /^\d{3}_.*\.sql$/.test(file))
        .sort())
        await client.query(await readFile(new URL(file, directory), "utf8"));
      await seedFixtures(client);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const form = parsePublicForm(await readPublicForm(pool, "demo-survey"));
    const valid = validSubmission(form);
    await suite.test(
      "invalid public paths return client errors without writes or webhook attempts",
      async () => {
        const before = await counts();
        const attemptsBefore = (
          await pool.query("SELECT count(*) FROM webhook_attempts")
        ).rows[0].count;
        for (const [slug, status, code] of [
          ["%00", 404, "NOT_FOUND"],
          ["demo-survey%0A", 404, "NOT_FOUND"],
          ["%E0%A4%A", 400, "INVALID_PATH"],
          ["%", 400, "INVALID_PATH"],
          [randomUUID(), 404, "NOT_FOUND"],
        ] as const) {
          for (const response of [
            await fetch(
              `http://127.0.0.1:${address.port}/public/forms/${slug}`,
            ),
            await request(valid, slug),
          ]) {
            assert.equal(response.status, status);
            assert.equal(
              record(record(await response.json()).error).code,
              code,
            );
          }
        }
        await assert.rejects(readPublicForm(pool, "\u0000"), /Form not found/);
        assert.throws(
          () => submitResponse(pool, "\u0000", valid),
          /Form not found/,
        );
        assert.deepEqual(await counts(), before);
        assert.equal(
          (await pool.query("SELECT count(*) FROM webhook_attempts")).rows[0]
            .count,
          attemptsBefore,
        );
      },
    );
    await suite.test(
      "HTTP parser enforces the shared exact byte limit",
      async () => {
        const before = await counts();
        // Invalid email ensures the boundary probe does not create a response/job.
        const body = { ...valid, email: "", padding: "" };
        body.padding = "a".repeat(
          submissionBodyLimitBytes - Buffer.byteLength(JSON.stringify(body)),
        );
        assert.equal(
          Buffer.byteLength(JSON.stringify(body)),
          submissionBodyLimitBytes,
        );
        const atLimit = await request(body);
        assert.equal(atLimit.status, 400);
        assert.equal(
          record(record(await atLimit.json()).error).code,
          "INVALID_SUBMISSION",
        );
        body.padding += "a";
        assert.equal((await request(body)).status, 413);
        assert.deepEqual(await counts(), before);
      },
    );
    const originalHistory = (
      await pool.query(
        "SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS snapshot FROM version_questions q",
      )
    ).rows[0].snapshot;

    await suite.test(
      "anonymous submission saves all eight types, dates and ordered selections; repeated emails work",
      async () => {
        for (let repeat = 0; repeat < 2; repeat++) {
          const response = await request(valid);
          assert.equal(response.status, 201);
          assert.equal(response.headers.get("cache-control"), "no-store");
          const result = record(record(await response.json()).response);
          assert.deepEqual(Object.keys(result).sort(), ["id", "submittedAt"]);
          const stored = await pool.query(
            "SELECT * FROM answers WHERE response_id=$1",
            [result.id],
          );
          assert.equal(stored.rowCount, 8);
          for (const answer of stored.rows) {
            const input = valid.answers.find(
              (entry) => entry.questionId === answer.question_id,
            );
            assert.ok(input);
            if (answer.question_type === "date")
              assert.equal(answer.date_value, "2024-02-29");
            if (["short_text", "long_text"].includes(answer.question_type))
              assert.equal(answer.text_value, input.value);
            if (answer.question_type === "linear_scale")
              assert.equal(answer.integer_value, input.value);
            if (
              [
                "dropdown",
                "multiple_choice",
                "checkboxes",
                "multi_select",
              ].includes(answer.question_type)
            ) {
              const selections = await pool.query(
                "SELECT option_id FROM answer_selections WHERE answer_id=$1 ORDER BY selection_position",
                [answer.id],
              );
              assert.deepEqual(
                selections.rows.map((selection) => selection.option_id),
                Array.isArray(input.value) ? input.value : [input.value],
              );
            }
          }
        }
      },
    );
    await suite.test(
      "email normalization and plus-addressing remain valid",
      async () => {
        for (const email of [
          "  Person+survey@Example.test  ",
          "first.last@my-domain.example.test",
        ]) {
          const result = await request({ ...valid, email });
          assert.equal(result.status, 201);
          const id = record(record(await result.json()).response).id;
          const stored = await pool.query(
            "SELECT email FROM responses WHERE id=$1",
            [id],
          );
          assert.equal(stored.rows[0].email, email.trim().toLowerCase());
        }
      },
    );
    await suite.test(
      "optional omissions/null/empty values store null rows without selections",
      async () => {
        for (const blank of [null, "", " \t", []]) {
          const body = {
            ...valid,
            answers: valid.answers
              .filter(
                (answer) =>
                  form.questions.find(
                    (question) => question.id === answer.questionId,
                  )?.required,
              )
              .concat(
                form.questions
                  .filter((question) => !question.required)
                  .map((question) => ({
                    questionId: question.id,
                    value:
                      Array.isArray(blank) &&
                      !["checkboxes", "multi_select"].includes(question.type)
                        ? null
                        : blank,
                  })),
              ),
          };
          const response = await request(body);
          assert.equal(response.status, 201);
          const id = record(record(await response.json()).response).id;
          const blanks = await pool.query(
            "SELECT a.* FROM answers a JOIN version_questions q ON q.id=a.question_id WHERE response_id=$1 AND NOT q.required",
            [id],
          );
          assert.equal(
            blanks.rowCount,
            form.questions.filter((question) => !question.required).length,
          );
          for (const answer of blanks.rows) {
            assert.equal(answer.text_value, null);
            assert.equal(answer.date_value, null);
            assert.equal(answer.integer_value, null);
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM answer_selections WHERE answer_id=$1",
                  [answer.id],
                )
              ).rowCount,
              0,
            );
          }
        }
        const omitted = {
          ...valid,
          answers: valid.answers.filter(
            (answer) =>
              form.questions.find(
                (question) => question.id === answer.questionId,
              )?.required,
          ),
        };
        assert.equal((await request(omitted)).status, 201);
      },
    );
    await suite.test(
      "bad answers for every type, email, duplicate/unknown IDs reject without writes",
      async () => {
        const before = await counts();
        const invalid: unknown[] = [
          { ...valid, email: "bad-email" },
          ...[
            "a@example..com",
            "a@-example.com",
            "a@example-.com",
            "a@exam\u0001ple.com",
            "a@exam\u007fple.com",
            "a@exam\u0085ple.com",
            ".a@example.com",
            "a..b@example.com",
            "a.@example.com",
            "a@exa_mple.com",
            `a@${"x".repeat(64)}.com`,
            `${"a".repeat(65)}@example.com`,
          ].map((email) => ({ ...valid, email })),
          { ...valid, email: "nul\u0000@example.test" },
          { ...valid, formVersionId: "bad" },
          { ...valid, answers: [...valid.answers, valid.answers[0]] },
          {
            ...valid,
            answers: [
              ...valid.answers,
              { questionId: randomUUID(), value: "unknown" },
            ],
          },
          {
            ...valid,
            answers: valid.answers
              .map((answer) => ({
                ...answer,
                questionId: answer.questionId.toUpperCase(),
              }))
              .concat(valid.answers[0] ?? []),
          },
        ];
        for (const question of form.questions) {
          let badValues: unknown[];
          switch (question.type) {
            case "short_text":
              badValues = [
                [],
                7,
                "line\nbreak",
                "bad\u0000text",
                "\uD800",
                "x".repeat(1001),
              ];
              break;
            case "long_text":
              badValues = [7, {}, "bad\u0000text", "x".repeat(10001)];
              break;
            case "date":
              badValues = [
                5,
                "2025-02-29",
                "2024-04-31",
                "0000-01-01",
                "2024-13-01",
                "2024-01-00",
                "infinity",
                "2024-01-01T00:00:00Z",
              ];
              break;
            case "linear_scale":
              badValues = [
                "3",
                1.5,
                (question.min ?? 0) - 1,
                (question.max ?? 0) + 1,
                false,
                {},
              ];
              break;
            case "dropdown":
            case "multiple_choice":
              badValues = [[], 5, randomUUID(), fixtureId("v1:team:0")];
              break;
            case "multi_select":
            case "checkboxes":
              badValues = [
                5,
                "wrong",
                [randomUUID()],
                [question.options[0]?.id, question.options[0]?.id],
              ];
              break;
          }
          if (question.required) badValues.push(null, " ", []);
          for (const value of badValues)
            invalid.push({
              ...valid,
              answers: valid.answers.map((answer) =>
                answer.questionId === question.id
                  ? { ...answer, value }
                  : answer,
              ),
            });
          if (question.required)
            invalid.push({
              ...valid,
              answers: valid.answers.filter(
                (answer) => answer.questionId !== question.id,
              ),
            });
          // Exercise requiredness even for types that are optional in this fixture.
          for (const value of [null, " ", []]) {
            const requiredForm = {
              ...form,
              questions: form.questions.map((entry) =>
                entry.id === question.id ? { ...entry, required: true } : entry,
              ),
            };
            assert.throws(() =>
              validateAnswers(requiredForm, {
                ...valid,
                answers: valid.answers.map((answer) =>
                  answer.questionId === question.id
                    ? { ...answer, value }
                    : answer,
                ),
              }),
            );
          }
        }
        const choices = form.questions.filter(
          (question) => "options" in question,
        );
        const first = choices[0];
        const other = choices[1];
        assert.ok(first && other && "options" in other);
        const historicalOption = (
          await pool.query<{ id: string }>(
            "SELECT o.id FROM question_options o JOIN version_questions q ON q.id=o.question_id JOIN form_versions v ON v.id=q.form_version_id WHERE v.form_id=$1 AND v.version_number=1 LIMIT 1",
            [fixtureId("survey")],
          )
        ).rows[0];
        assert.ok(historicalOption);
        invalid.push({
          ...valid,
          answers: valid.answers.map((answer) =>
            answer.questionId === first.id
              ? { ...answer, value: historicalOption.id }
              : answer,
          ),
        });
        invalid.push({
          ...valid,
          answers: valid.answers.map((answer) =>
            answer.questionId === first.id
              ? { ...answer, value: other.options[0]?.id }
              : answer,
          ),
        });
        for (const body of invalid) {
          const result = await request(body);
          assert.equal(result.status, 400, JSON.stringify(body));
          const error = record(record(await result.json()).error);
          assert.equal(error.code, "INVALID_SUBMISSION");
          assert.equal(typeof error.field, "string");
        }
        assert.deepEqual(await counts(), before);
        assert.throws(() =>
          parseSubmission({
            ...valid,
            answers: [{ questionId: form.questions[0]?.id }],
          }),
        );
      },
    );
    await suite.test(
      "JSON/origin limits and draft/archived/unknown/stale forms cannot accept responses",
      async () => {
        const before = await counts();
        assert.equal((await request(valid, "demo-survey", null)).status, 403);
        assert.equal(
          (await request(valid, "demo-survey", "http://malicious-site.com"))
            .status,
          403,
        );
        assert.equal(
          (await request(valid, "demo-survey", config.webOrigin, "text/plain"))
            .status,
          415,
        );
        assert.equal(
          (await request({ ...valid, padding: "x".repeat(2 * 1024 * 1024) }))
            .status,
          413,
        );
        for (const slug of ["demo-draft", "demo-archived", "missing"])
          assert.equal((await request(valid, slug)).status, 404);
        const stale = await request({ ...valid, formVersionId: randomUUID() });
        assert.equal(stale.status, 409);
        assert.equal(
          record(record(await stale.json()).error).code,
          "FORM_UPDATED",
        );
        assert.deepEqual(await counts(), before);
      },
    );
    await suite.test(
      "a database failure after earlier answer inserts rolls back the entire submission",
      async () => {
        const before = await counts();
        await pool.query(
          `CREATE FUNCTION reject_test_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.question_type='linear_scale' THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_answer BEFORE INSERT ON answers FOR EACH ROW EXECUTE FUNCTION reject_test_answer()`,
        );
        try {
          assert.equal((await request(valid)).status, 500);
          assert.deepEqual(await counts(), before);
        } finally {
          await pool.query(
            "DROP TRIGGER reject_test_answer ON answers; DROP FUNCTION reject_test_answer()",
          );
        }
      },
    );

    const ownerId = fixtureId("alpha");
    const draft = parseDraft(
      (
        await pool.query(
          "SELECT definition FROM form_drafts WHERE form_id=$1",
          [fixtureId("survey")],
        )
      ).rows[0].definition,
    );
    for (const operation of ["publish", "unpublish", "archive"] as const) {
      for (const submissionFirst of [false, true]) {
        await suite.test(
          `${operation} race: ${submissionFirst ? "submission" : "mutation"} gets the lock first`,
          async () => {
            const created = await createDraft(pool, ownerId);
            await saveDraft(
              pool,
              ownerId,
              created.id,
              draft,
              draftETag({ title: "", description: null, questions: [] }),
            );
            await publishForm(pool, ownerId, created.id, randomUUID(), draft);
            const slug = (
              await pool.query("SELECT slug FROM forms WHERE id=$1", [
                created.id,
              ])
            ).rows[0].slug;
            const body = validSubmission(
              parsePublicForm(await readPublicForm(pool, slug)),
            );
            const mutate = () =>
              operation === "publish"
                ? publishForm(pool, ownerId, created.id, randomUUID(), draft)
                : operation === "unpublish"
                  ? unpublishForm(pool, ownerId, created.id)
                  : archiveForm(pool, ownerId, created.id);
            const blocker = await pool.connect();
            try {
              if (submissionFirst) {
                await blocker.query("SELECT pg_advisory_lock(3030101)");
                await pool.query(
                  `CREATE FUNCTION pause_test_response() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(3030101); RETURN NEW; END $$; CREATE TRIGGER pause_test_response BEFORE INSERT ON responses FOR EACH ROW EXECUTE FUNCTION pause_test_response()`,
                );
                const submitting = request(body, slug);
                await waitForLock("INSERT INTO responses");
                const mutation = mutate();
                await waitForLock("SELECT id FROM forms WHERE id=");
                await blocker.query("SELECT pg_advisory_unlock(3030101)");
                assert.equal((await submitting).status, 201);
                await mutation;
                await pool.query(
                  "DROP TRIGGER pause_test_response ON responses; DROP FUNCTION pause_test_response()",
                );
              } else {
                await blocker.query("BEGIN");
                await blocker.query(
                  "SELECT id FROM forms WHERE id=$1 FOR UPDATE",
                  [created.id],
                );
                const mutation = mutate();
                await waitForLock("SELECT id FROM forms WHERE id=");
                const submitting = request(body, slug);
                await waitForLock(
                  "SELECT id,current_version_id,is_published,deleted_at FROM forms",
                );
                await blocker.query("COMMIT");
                await mutation;
                const result = await submitting;
                assert.equal(
                  result.status,
                  operation === "publish" ? 409 : 404,
                );
              }
              const saved = await pool.query(
                "SELECT r.form_version_id FROM responses r JOIN form_versions v ON v.id=r.form_version_id WHERE v.form_id=$1",
                [created.id],
              );
              assert.equal(saved.rowCount, submissionFirst ? 1 : 0);
              if (submissionFirst)
                assert.equal(saved.rows[0].form_version_id, body.formVersionId);
            } finally {
              await blocker.query("ROLLBACK");
              await blocker.query("SELECT pg_advisory_unlock_all()");
              blocker.release();
            }
          },
        );
      }
    }
    assert.deepEqual(
      (
        await pool.query(
          "SELECT jsonb_agg(to_jsonb(q) ORDER BY id) AS snapshot FROM version_questions q WHERE form_version_id=ANY($1::uuid[])",
          [
            (
              await pool.query(
                "SELECT id FROM form_versions WHERE form_id=ANY($1::uuid[])",
                [
                  [
                    fixtureId("survey"),
                    fixtureId("archived"),
                    fixtureId("acknowledgment"),
                  ],
                ],
              )
            ).rows.map((row) => row.id),
          ],
        )
      ).rows[0].snapshot,
      originalHistory,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await drainWebhooks(pool);
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
