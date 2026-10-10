import assert from "node:assert/strict";
import { randomUUID, scryptSync } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabasePool } from "../src/database.js";
import { demoPassword, fixtureId, seedFixtures } from "../scripts/fixtures.js";

test("assessment fixtures against real PostgreSQL", async (suite) => {
  const pool = createDatabasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // An isolated schema, created and rolled back in this transaction, keeps tests
    // repeatable even after the developer edits their seeded application records.
    const schema = `seed_test_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    const migrations = new URL(
      "../../../database/migrations/",
      import.meta.url,
    );
    for (const file of (await readdir(migrations))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()) {
      await client.query(await readFile(new URL(file, migrations), "utf8"));
    }
    await client.query("SAVEPOINT empty_database");

    await suite.test("partial roots fail without adding fixtures", async () => {
      await client.query(
        "INSERT INTO users (id,email,password_hash) VALUES ($1,'partial@example.test','test')",
        [fixtureId("alpha")],
      );
      await assert.rejects(seedFixtures(client), /Partial seed roots/);
      assert.equal(
        (await client.query("SELECT count(*)::int AS count FROM users")).rows[0]
          .count,
        1,
      );
      await client.query("ROLLBACK TO SAVEPOINT empty_database");
    });

    await suite.test(
      "an email collision rolls back all seed writes",
      async () => {
        await client.query(
          "INSERT INTO users (email,password_hash) VALUES ('owner.beta@example.test','existing')",
        );
        await client.query("SAVEPOINT seed_operation");
        await assert.rejects(seedFixtures(client), { code: "23505" });
        await client.query("ROLLBACK TO SAVEPOINT seed_operation");
        assert.equal(
          (await client.query("SELECT count(*)::int AS count FROM users"))
            .rows[0].count,
          1,
        );
        assert.equal(
          (await client.query("SELECT count(*)::int AS count FROM forms"))
            .rows[0].count,
          0,
        );
        await client.query("ROLLBACK TO SAVEPOINT empty_database");
      },
    );

    await suite.test(
      "creates the required owners, form states, history and responses",
      async () => {
        assert.equal(await seedFixtures(client), "created");
        const counts = await client.query(`SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM forms) AS forms,
        (SELECT count(*)::int FROM form_drafts) AS drafts,
        (SELECT count(*)::int FROM form_versions) AS versions,
        (SELECT count(*)::int FROM responses) AS responses,
        (SELECT count(*)::int FROM answers) AS answers,
        (SELECT count(DISTINCT type)::int FROM version_questions) AS types,
        (SELECT count(*)::int FROM form_webhooks) AS webhooks,
        (SELECT count(*)::int FROM webhook_attempts) AS attempts`);
        assert.deepEqual(counts.rows[0], {
          users: 2,
          forms: 4,
          drafts: 4,
          versions: 4,
          responses: 7,
          answers: 49,
          types: 8,
          webhooks: 1,
          attempts: 0,
        });
        const states = await client.query(
          "SELECT slug,is_published,current_version_id,deleted_at FROM forms ORDER BY slug",
        );
        assert.equal(states.rows[0].slug, "demo-acknowledgment");
        assert.equal(states.rows[0].is_published, true);
        assert.equal(states.rows[1].is_published, false);
        assert.ok(states.rows[1].deleted_at);
        assert.equal(states.rows[2].current_version_id, null);
        assert.equal(states.rows[3].current_version_id, fixtureId("survey:v2"));
        const perVersion = await client.query(
          "SELECT v.version_number,count(r.id)::int AS count FROM form_versions v LEFT JOIN responses r ON r.form_version_id=v.id WHERE v.form_id=$1 GROUP BY v.version_number ORDER BY v.version_number",
          [fixtureId("survey")],
        );
        assert.deepEqual(perVersion.rows, [
          { version_number: 1, count: 2 },
          { version_number: 2, count: 4 },
        ]);
        assert.equal(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM responses WHERE form_version_id=$1",
              [fixtureId("acknowledgment:v1")],
            )
          ).rows[0].count,
          0,
        );
      },
    );

    await suite.test(
      "valid edge answers include blanks, repeated email, dates, and selections",
      async () => {
        assert.ok(
          (
            await client.query(
              "SELECT id FROM answers WHERE date_value='2024-02-29'",
            )
          ).rowCount,
        );
        assert.ok(
          (
            await client.query(
              "SELECT id FROM answers WHERE text_value='=SUM(1,2)'",
            )
          ).rowCount,
        );
        assert.ok(
          (
            await client.query(
              "SELECT email FROM responses GROUP BY email HAVING count(*)>1",
            )
          ).rowCount,
        );
        const invalid =
          await client.query(`SELECT a.id FROM answers a JOIN version_questions q ON q.id=a.question_id
        WHERE (q.required AND ((q.type IN ('short_text','long_text') AND a.text_value IS NULL)
          OR (q.type='date' AND a.date_value IS NULL) OR (q.type='linear_scale' AND a.integer_value IS NULL)
          OR (q.type IN ('dropdown','multi_select','multiple_choice','checkboxes') AND NOT EXISTS (SELECT 1 FROM answer_selections s WHERE s.answer_id=a.id))))
          OR (q.type='linear_scale' AND a.integer_value NOT BETWEEN q.scale_min AND q.scale_max)`);
        assert.equal(invalid.rowCount, 0);
        assert.ok(
          (
            await client.query(
              "SELECT a.id FROM answers a JOIN version_questions q ON q.id=a.question_id WHERE NOT q.required AND a.text_value IS NULL AND a.date_value IS NULL AND NOT EXISTS (SELECT 1 FROM answer_selections s WHERE s.answer_id=a.id)",
            )
          ).rowCount,
        );
        assert.ok(
          (
            await client.query(
              "SELECT answer_id FROM answer_selections GROUP BY answer_id HAVING count(*)>1",
            )
          ).rowCount,
        );
        const dates = await client.query(
          "SELECT date_value FROM answers WHERE date_value IS NOT NULL",
        );
        assert.equal(dates.rows[0].date_value, "2024-02-29");
      },
    );

    await suite.test(
      "historical selections retain the original option and scale",
      async () => {
        const history = await client.query(`SELECT v.version_number,o.label
        FROM answer_selections s JOIN question_options o ON o.id=s.option_id
        JOIN answers a ON a.id=s.answer_id JOIN form_versions v ON v.id=a.form_version_id
        WHERE a.question_type='dropdown' AND o.position=0 ORDER BY v.version_number`);
        assert.deepEqual(history.rows, [
          { version_number: 1, label: "Engineering" },
          { version_number: 2, label: "Product Engineering" },
          { version_number: 2, label: "Product Engineering" },
        ]);
        const scales = await client.query(
          "SELECT v.version_number,q.scale_max FROM version_questions q JOIN form_versions v ON v.id=q.form_version_id WHERE q.type='linear_scale' ORDER BY v.version_number",
        );
        assert.deepEqual(scales.rows, [
          { version_number: 1, scale_max: 5 },
          { version_number: 2, scale_max: 10 },
        ]);
        assert.equal(
          (
            await client.query(
              "SELECT r.id FROM responses r JOIN form_versions v ON v.id=r.form_version_id JOIN forms f ON f.id=v.form_id WHERE r.submitted_at<v.published_at OR v.published_at<f.created_at OR r.submitted_at>f.deleted_at",
            )
          ).rowCount,
          0,
        );
      },
    );

    await suite.test("demo passwords are salted scrypt hashes", async () => {
      const owners = await client.query<{ password_hash: string }>(
        "SELECT password_hash FROM users ORDER BY email",
      );
      assert.notEqual(
        owners.rows[0]?.password_hash,
        owners.rows[1]?.password_hash,
      );
      for (const owner of owners.rows) {
        const [algorithm, cost, blockSize, parallelism, salt, hash] =
          owner.password_hash.split("$");
        assert.equal(algorithm, "scrypt");
        assert.ok(salt);
        assert.equal(
          scryptSync(demoPassword, salt, 64, {
            N: Number(cost),
            r: Number(blockSize),
            p: Number(parallelism),
            maxmem: 64 * 1024 * 1024,
          }).toString("hex"),
          hash,
        );
      }
    });

    await suite.test(
      "rerun preserves edits and does not duplicate records",
      async () => {
        await client.query(
          "UPDATE form_drafts SET definition=$2 WHERE form_id=$1",
          [fixtureId("draft"), { title: "My edited draft", questions: [] }],
        );
        await client.query(
          "UPDATE users SET password_hash='changed-by-owner' WHERE id=$1",
          [fixtureId("alpha")],
        );
        assert.equal(await seedFixtures(client), "already present");
        assert.equal(
          (
            await client.query(
              "SELECT definition->>'title' AS title FROM form_drafts WHERE form_id=$1",
              [fixtureId("draft")],
            )
          ).rows[0].title,
          "My edited draft",
        );
        assert.equal(
          (
            await client.query("SELECT password_hash FROM users WHERE id=$1", [
              fixtureId("alpha"),
            ])
          ).rows[0].password_hash,
          "changed-by-owner",
        );
        assert.equal(
          (await client.query("SELECT count(*)::int AS count FROM responses"))
            .rows[0].count,
          7,
        );
      },
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
