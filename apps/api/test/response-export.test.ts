import ExcelJS from "exceljs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../src/app.js";
import { readAuthConfig } from "../src/auth.js";
import { createDatabasePool } from "../src/database.js";
import { fixtureId, seedFixtures, demoPassword } from "../scripts/fixtures.js";
import { parseDraft } from "../src/contracts/draft.js";
import { archiveForm, saveDraft } from "../src/form-drafts.js";
import { publishForm, unpublishForm } from "../src/publication.js";

test("XLSX export preserves version tabs and owner boundaries", async (suite) => {
  const schema = `export_test_${randomUUID().replaceAll("-", "")}`;
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
  const path = `/forms/${formId}/responses/export`;
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
    async function workbookAt(url: string, cookie: string) {
      const response = await get(url, cookie);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type") ?? "", /spreadsheetml/);
      assert.match(
        response.headers.get("content-disposition") ?? "",
        /attachment;.*\.xlsx/,
      );
      const bytes = await response.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      return { workbook, bytes: Buffer.from(bytes) };
    }
    const initial = await workbookAt(path, alpha);
    await suite.test(
      "version tabs contain only their own rows, ordered original columns and safe text",
      async () => {
        assert.deepEqual(
          initial.workbook.worksheets.map((s) => s.name),
          ["Version 1", "Version 2"],
        );
        assert.deepEqual(
          initial.workbook.worksheets.map((s) => s.rowCount),
          [3, 5],
        );
        for (const sheet of initial.workbook.worksheets) {
          assert.equal(sheet.getCell("A1").value, "Email");
          assert.equal(sheet.getCell("B1").value, "Submitted at (UTC)");
          assert.equal(sheet.getCell("C1").value, "1. Details");
          assert.equal(sheet.getCell("D1").value, "2. Details");
          assert.equal(sheet.getCell("F1").value, "4. Team");
          sheet.eachRow((row) =>
            row.eachCell((cell) =>
              assert.notEqual(cell.type, ExcelJS.ValueType.Formula),
            ),
          );
        }
        const v1 = initial.workbook.getWorksheet("Version 1");
        assert.ok(v1);
        assert.equal(v1.getCell("D2").value, null);
        assert.equal(v1.getCell("C3").value, "=SUM(1,2)");
        assert.equal(v1.getCell("E3").value, "2024-02-29");
        assert.equal(v1.getCell("G3").value, "Design\nSQL");
        assert.equal(typeof v1.getCell("J3").value, "number");
        assert.match(String(v1.getCell("B3").value), /Z$/);
        await mkdir(new URL("../../../docs/review/", import.meta.url), {
          recursive: true,
        });
        await writeFile(
          new URL("../../../docs/review/export-versions.xlsx", import.meta.url),
          initial.bytes,
        );
      },
    );
    await suite.test(
      "every cell matches its response and historical question ID",
      async () => {
        const versions = await pool.query(
          "SELECT id,version_number FROM form_versions WHERE form_id=$1 ORDER BY version_number",
          [formId],
        );
        for (const version of versions.rows) {
          const sheet = initial.workbook.getWorksheet(
            `Version ${version.version_number}`,
          );
          assert.ok(sheet);
          const questions = await pool.query(
            "SELECT id,label FROM version_questions WHERE form_version_id=$1 ORDER BY position",
            [version.id],
          );
          const responses = await pool.query(
            "SELECT id,email,submitted_at FROM responses WHERE form_version_id=$1 ORDER BY submitted_at,id",
            [version.id],
          );
          assert.equal(sheet.rowCount, responses.rows.length + 1);
          for (const [rowIndex, response] of responses.rows.entries()) {
            assert.equal(sheet.getCell(rowIndex + 2, 1).value, response.email);
            assert.equal(
              sheet.getCell(rowIndex + 2, 2).value,
              response.submitted_at.toISOString(),
            );
            for (const [columnIndex, question] of questions.rows.entries()) {
              assert.equal(
                sheet.getCell(1, columnIndex + 3).value,
                `${columnIndex + 1}. ${question.label}`,
              );
              const answer = (
                await pool.query(
                  "SELECT id,text_value,date_value::text,integer_value FROM answers WHERE response_id=$1 AND question_id=$2",
                  [response.id, question.id],
                )
              ).rows[0];
              const choices = answer
                ? (
                    await pool.query(
                      "SELECT o.label FROM answer_selections s JOIN question_options o ON o.id=s.option_id WHERE s.answer_id=$1 ORDER BY s.selection_position",
                      [answer.id],
                    )
                  ).rows
                : [];
              const expected = choices.length
                ? choices.map((choice) => choice.label).join("\n")
                : (answer?.text_value ??
                  answer?.date_value ??
                  answer?.integer_value ??
                  null);
              assert.equal(
                sheet.getCell(rowIndex + 2, columnIndex + 3).value,
                expected,
              );
            }
          }
        }
      },
    );
    await suite.test(
      "OOXML-like text, controls, carriage returns and Unicode survive download",
      async () => {
        const original = (
          await pool.query(
            "SELECT a.id,a.text_value FROM answers a JOIN responses r ON r.id=a.response_id WHERE r.form_version_id=$1 AND a.question_type='long_text' ORDER BY r.submitted_at LIMIT 1",
            [fixtureId("survey:v1")],
          )
        ).rows[0];
        assert.ok(original);
        const text =
          "literal _x000D_ _x005F_ _x0041_\r\nline\twith\u000bcontrol 🐈 李 =SUM(1,2)";
        try {
          await pool.query("UPDATE answers SET text_value=$1 WHERE id=$2", [
            text,
            original.id,
          ]);
          const exported = await workbookAt(path, alpha);
          assert.equal(
            exported.workbook.getWorksheet("Version 1")?.getCell("D2").value,
            text,
          );
          await writeFile(
            new URL(
              "../../../docs/review/export-text-edge.xlsx",
              import.meta.url,
            ),
            exported.bytes,
          );
        } finally {
          await pool.query("UPDATE answers SET text_value=$1 WHERE id=$2", [
            original.text_value,
            original.id,
          ]);
        }
      },
    );
    await suite.test(
      "overlong cells fail before attachment headers instead of truncating",
      async () => {
        const original = (
          await pool.query(
            "SELECT a.id,a.text_value FROM answers a JOIN responses r ON r.id=a.response_id WHERE r.form_version_id=$1 AND a.question_type='long_text' LIMIT 1",
            [fixtureId("survey:v1")],
          )
        ).rows[0];
        try {
          await pool.query("UPDATE answers SET text_value=$1 WHERE id=$2", [
            "x".repeat(32768),
            original.id,
          ]);
          const response = await get(path, alpha);
          assert.equal(response.status, 422);
          assert.equal(response.headers.get("content-disposition"), null);
          assert.match(response.headers.get("content-type") ?? "", /json/);
          assert.deepEqual(await response.json(), {
            error: {
              code: "EXPORT_CELL_TOO_LONG",
              message: "An answer exceeds Excel's cell text limit.",
            },
          });
        } finally {
          await pool.query("UPDATE answers SET text_value=$1 WHERE id=$2", [
            original.text_value,
            original.id,
          ]);
        }
      },
    );
    await suite.test(
      "export is not limited to 50 rows; repeated emails and missing answers stay aligned",
      async () => {
        const inserted = await pool.query<{ id: string }>(
          "INSERT INTO responses(form_version_id,email,submitted_at) SELECT $1,'repeat@example.test','2030-01-01T00:00:00Z' FROM generate_series(1,55) RETURNING id",
          [fixtureId("survey:v1")],
        );
        try {
          const exported = await workbookAt(path, alpha);
          const sheet = exported.workbook.getWorksheet("Version 1");
          assert.ok(sheet);
          assert.equal(sheet.rowCount, 58);
          for (let row = 4; row <= 58; row++) {
            assert.equal(sheet.getCell(row, 1).value, "repeat@example.test");
            assert.equal(
              sheet.getCell(row, 2).value,
              "2030-01-01T00:00:00.000Z",
            );
            for (let column = 3; column <= 10; column++)
              assert.equal(sheet.getCell(row, column).value, null);
          }
          assert.deepEqual(
            exported.workbook.getWorksheet("Version 2")?.getSheetValues(),
            initial.workbook.getWorksheet("Version 2")?.getSheetValues(),
          );
        } finally {
          await pool.query("DELETE FROM responses WHERE id=ANY($1::uuid[])", [
            inserted.rows.map((response) => response.id),
          ]);
        }
      },
    );
    await suite.test(
      "ownership, missing IDs and archived forms cannot download",
      async () => {
        assert.equal((await get(path)).status, 401);
        assert.equal((await get(path, beta)).status, 404);
        for (const id of [randomUUID(), "invalid", fixtureId("archived")])
          assert.equal(
            (await get(`/forms/${id}/responses/export`, beta)).status,
            404,
          );
      },
    );
    await suite.test(
      "empty published and draft exports have useful header-only sheets",
      async () => {
        const published = await workbookAt(
          `/forms/${fixtureId("acknowledgment")}/responses/export`,
          beta,
        );
        assert.deepEqual(
          published.workbook.worksheets.map((s) => s.name),
          ["Version 1"],
        );
        assert.equal(published.workbook.worksheets[0]?.rowCount, 1);
        const emptyFormId = fixtureId("acknowledgment");
        const emptyDraft = parseDraft(
          (
            await pool.query(
              "SELECT definition FROM form_drafts WHERE form_id=$1",
              [emptyFormId],
            )
          ).rows[0].definition,
        );
        await publishForm(
          pool,
          fixtureId("beta"),
          emptyFormId,
          randomUUID(),
          emptyDraft,
        );
        await unpublishForm(pool, fixtureId("beta"), emptyFormId);
        const latestEmpty = await workbookAt(
          `/forms/${emptyFormId}/responses/export`,
          beta,
        );
        assert.deepEqual(
          latestEmpty.workbook.worksheets.map((s) => s.name),
          ["Version 2"],
        );
        assert.equal(latestEmpty.workbook.worksheets[0]?.rowCount, 1);
        const draft = await workbookAt(
          `/forms/${fixtureId("draft")}/responses/export`,
          alpha,
        );
        assert.deepEqual(
          draft.workbook.worksheets.map((s) => s.name),
          ["Responses"],
        );
        assert.equal(draft.workbook.worksheets[0]?.columnCount, 2);
        assert.equal(draft.workbook.worksheets[0]?.rowCount, 1);
        await writeFile(
          new URL("../../../docs/review/export-empty.xlsx", import.meta.url),
          draft.bytes,
        );
      },
    );
    await suite.test(
      "republish/edit cannot alter historical tabs; unpublish retains export",
      async () => {
        const draft = parseDraft(
          (
            await pool.query(
              "SELECT definition FROM form_drafts WHERE form_id=$1",
              [formId],
            )
          ).rows[0].definition,
        );
        draft.questions = draft.questions.slice(0, 1);
        const question = draft.questions[0];
        assert.ok(question);
        question.label = "A changed question";
        await saveDraft(pool, fixtureId("alpha"), formId, draft);
        await publishForm(
          pool,
          fixtureId("alpha"),
          formId,
          randomUUID(),
          draft,
        );
        await unpublishForm(pool, fixtureId("alpha"), formId);
        const exported = await workbookAt(path, alpha);
        assert.deepEqual(
          exported.workbook.worksheets.map((s) => s.name),
          ["Version 1", "Version 2"],
        );
        for (const [i, sheet] of exported.workbook.worksheets.entries())
          assert.deepEqual(
            sheet.getSheetValues(),
            initial.workbook.worksheets[i]?.getSheetValues(),
          );
        const inserted = await pool.query<{
          id: string;
          form_version_id: string;
        }>(
          "INSERT INTO responses(form_version_id,email) SELECT current_version_id,'new-version@example.test' FROM forms WHERE id=$1 RETURNING id,form_version_id",
          [formId],
        );
        const latest = inserted.rows[0];
        assert.ok(latest);
        await pool.query(
          "INSERT INTO answers(response_id,form_version_id,question_id,question_type,text_value) SELECT $1,$2,id,type,'Only version three' FROM version_questions WHERE form_version_id=$2",
          [latest.id, latest.form_version_id],
        );
        const threeVersions = await workbookAt(path, alpha);
        assert.deepEqual(
          threeVersions.workbook.worksheets.map((s) => s.name),
          ["Version 1", "Version 2", "Version 3"],
        );
        const third = threeVersions.workbook.getWorksheet("Version 3");
        assert.ok(third);
        assert.equal(third.columnCount, 3);
        assert.equal(third.rowCount, 2);
        assert.equal(third.getCell("C1").value, "1. A changed question");
        assert.equal(third.getCell("C2").value, "Only version three");
        assert.deepEqual(
          threeVersions.workbook.worksheets[0]?.getSheetValues(),
          initial.workbook.worksheets[0]?.getSheetValues(),
        );
        await writeFile(
          new URL(
            "../../../docs/review/export-three-versions.xlsx",
            import.meta.url,
          ),
          threeVersions.bytes,
        );
        await archiveForm(pool, fixtureId("alpha"), formId);
        assert.equal((await get(path, alpha)).status, 404);
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
