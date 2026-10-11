import ExcelJS from "exceljs";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";

type ExportQuestion = { id: string; label: string };
type ExportResponse = {
  email: string;
  submittedAt: string;
  answers: {
    questionId: string;
    value: string | number | null;
    selections: string[];
  }[];
};
type ExportVersion = {
  number: number;
  questions: ExportQuestion[];
  responses: ExportResponse[];
};

function escapeSpreadsheetText(value: string): string {
  // ST_Xstring: protect literal escape-looking text before encoding XML-invalid
  // controls and CR. Otherwise ExcelJS drops controls or changes the original text.
  // https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/d34ae755-c53f-4a44-a363-c6dd3ee018a4
  const protectedText = value.replace(
    /_x[0-9a-f]{4}_/gi,
    (match) => `_x005F_${match.slice(1)}`,
  );
  return Array.from(protectedText, (character) => {
    const code = character.charCodeAt(0);
    if (
      (code < 32 && code !== 9 && code !== 10) ||
      code === 65534 ||
      code === 65535
    )
      return `_x${code.toString(16).toUpperCase().padStart(4, "0")}_`;
    return character;
  }).join("");
}

export async function buildResponseWorkbook(
  pool: Pool,
  ownerId: string,
  formId: string,
) {
  // One statement snapshot keeps visibility, version selection and rows consistent.
  // Fetch only historical definitions, never mutable draft content.
  const result = await pool.query<{ versions: ExportVersion[] }>(
    `SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'number',v.version_number,
      'questions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'label',q.label) ORDER BY q.position)
        FROM version_questions q WHERE q.form_version_id=v.id),'[]'::jsonb),
      'responses',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'email',r.email,'submittedAt',r.submitted_at,
        'answers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'questionId',a.question_id,
          'value',COALESCE(to_jsonb(a.text_value),to_jsonb(a.date_value::text),to_jsonb(a.integer_value)),
          'selections',COALESCE((SELECT jsonb_agg(o.label ORDER BY s.selection_position)
            FROM answer_selections s JOIN question_options o ON o.id=s.option_id AND o.question_id=a.question_id
            WHERE s.answer_id=a.id),'[]'::jsonb)))
          FROM answers a WHERE a.response_id=r.id AND a.form_version_id=v.id),'[]'::jsonb)
      ) ORDER BY r.submitted_at,r.id) FROM responses r WHERE r.form_version_id=v.id),'[]'::jsonb)
    ) ORDER BY v.version_number) FROM form_versions v WHERE v.form_id=f.id AND (
      EXISTS(SELECT 1 FROM responses r WHERE r.form_version_id=v.id)
      OR (v.id=f.current_version_id AND NOT EXISTS(
        SELECT 1 FROM responses r JOIN form_versions history ON history.id=r.form_version_id WHERE history.form_id=f.id))
    )),'[]'::jsonb) AS versions
    FROM forms f WHERE f.id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL`,
    [formId, ownerId],
  );
  const form = result.rows[0];
  if (!form) throw new HttpError(404, "NOT_FOUND", "Form not found.");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Forms App";
  const versions = form.versions.length
    ? form.versions
    : [{ number: 0, questions: [], responses: [] }];
  for (const version of versions) {
    if (
      version.questions.length + 2 > 16384 ||
      version.responses.length + 1 > 1048576
    )
      throw new HttpError(
        422,
        "EXPORT_TOO_LARGE",
        "This version exceeds Excel worksheet limits.",
      );
    const sheet = workbook.addWorksheet(
      version.number ? `Version ${version.number}` : "Responses",
    );
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    // Position prefixes disambiguate duplicate labels and system-column names.
    sheet.addRow([
      "Email",
      "Submitted at (UTC)",
      ...version.questions.map((q, index) => `${index + 1}. ${q.label}`),
    ]);
    for (const response of version.responses) {
      const answers = new Map(
        response.answers.map((answer) => [answer.questionId, answer]),
      );
      const values = version.questions.map((question) => {
        const answer = answers.get(question.id);
        if (!answer) return null;
        return answer.selections.length
          ? answer.selections.join("\n")
          : answer.value;
      });
      sheet.addRow([
        response.email,
        new Date(response.submittedAt).toISOString(),
        ...values,
      ]);
    }
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        // ExcelJS strings remain strings, even when they begin with '=' or '+'.
        if (typeof cell.value === "string" && cell.value.length > 32767)
          throw new HttpError(
            422,
            "EXPORT_CELL_TOO_LONG",
            "An answer exceeds Excel's cell text limit.",
          );
        if (typeof cell.value === "string")
          cell.value = escapeSpreadsheetText(cell.value);
        cell.alignment = { vertical: "top", wrapText: true };
      });
    });
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF3730A3" },
    };
    sheet.columns.forEach((column, index) => {
      column.width = 35;
      if (index === 0) column.width = 32;
      if (index === 1) column.width = 28;
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: version.questions.length + 2 },
    };
  }
  return workbook;
}
