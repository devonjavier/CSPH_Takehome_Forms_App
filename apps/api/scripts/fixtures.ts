import { createHash, randomBytes, scryptSync } from "node:crypto";
import type { PoolClient } from "pg";

export const demoPassword = "FormsDemo!2026";
export const fixtureId = (name: string): string => {
  const hex = createHash("sha256").update(`csph-db03:${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

type Question = { key: string; label: string; required: boolean } & (
  | { type: "short_text" | "long_text" | "date" }
  | {
      type: "dropdown" | "multi_select" | "multiple_choice" | "checkboxes";
      options: string[];
    }
  | { type: "linear_scale"; min: number; max: number }
);

function surveyQuestions(version: number): Question[] {
  return [
    { key: "name", label: "Details", type: "short_text", required: true },
    {
      key: version === 1 ? "legacy-notes" : "goals",
      label: "Details",
      type: "long_text",
      required: false,
    },
    { key: "date", label: "Preferred date", type: "date", required: false },
    {
      key: "team",
      label: "Team",
      type: "dropdown",
      required: true,
      options: [
        version === 1 ? "Engineering" : "Product Engineering",
        "Support",
      ],
    },
    {
      key: "skills",
      label: "Skills",
      type: "multi_select",
      required: false,
      options: ["SQL", "TypeScript", "Design"],
    },
    {
      key: "contact",
      label: "Contact preference",
      type: "multiple_choice",
      required: true,
      options: ["Email", "Phone"],
    },
    {
      key: "updates",
      label: "Send product updates",
      type: "checkboxes",
      required: false,
      options: ["Yes"],
    },
    {
      key: "rating",
      label: "Experience",
      type: "linear_scale",
      required: true,
      min: 1,
      max: version === 1 ? 5 : 10,
    },
  ];
}

async function insertVersion(
  client: PoolClient,
  form: string,
  version: number,
  title: string,
  questions: Question[],
): Promise<string> {
  const versionId = fixtureId(`${form}:v${version}`);
  await client.query(
    "INSERT INTO form_versions (id, form_id, version_number, publication_action_id, title, published_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      versionId,
      fixtureId(form),
      version,
      fixtureId(`${form}:publish${version}`),
      title,
      `2026-10-0${version}T08:00:00Z`,
    ],
  );
  for (const [position, question] of questions.entries()) {
    const questionId = fixtureId(`${versionId}:${question.key}`);
    await client.query(
      "INSERT INTO version_questions (id,form_version_id,label,type,position,required,scale_min,scale_max,scale_min_label,scale_max_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        questionId,
        versionId,
        question.label,
        question.type,
        position,
        question.required,
        question.type === "linear_scale" ? question.min : null,
        question.type === "linear_scale" ? question.max : null,
        question.type === "linear_scale" ? "Low" : null,
        question.type === "linear_scale" ? "High" : null,
      ],
    );
    if ("options" in question) {
      for (const [optionPosition, label] of question.options.entries()) {
        await client.query(
          "INSERT INTO question_options (id,question_id,question_type,label,position) VALUES ($1,$2,$3,$4,$5)",
          [
            fixtureId(`${questionId}:option${optionPosition}`),
            questionId,
            question.type,
            label,
            optionPosition,
          ],
        );
      }
    }
  }
  // Draft IDs are independent from immutable publication IDs.
  await client.query(
    "INSERT INTO form_drafts (form_id,definition) VALUES ($1,$2) ON CONFLICT (form_id) DO UPDATE SET definition = EXCLUDED.definition",
    [
      fixtureId(form),
      JSON.stringify({
        title,
        description: null,
        questions: questions.map(({ key, ...question }) => ({
          ...question,
          id: fixtureId(`${form}:draft:${key}`),
          ...("options" in question
            ? {
                options: question.options.map((label, position) => ({
                  id: fixtureId(`${form}:draft:${key}:option${position}`),
                  label,
                })),
              }
            : {}),
        })),
      }),
    ],
  );
  await client.query("UPDATE forms SET current_version_id=$2 WHERE id=$1", [
    fixtureId(form),
    versionId,
  ]);
  return versionId;
}

async function insertResponse(
  client: PoolClient,
  versionId: string,
  questions: Question[],
  sample: number,
): Promise<void> {
  const responseId = fixtureId(`${versionId}:response${sample}`);
  await client.query(
    "INSERT INTO responses (id,form_version_id,email,submitted_at) VALUES ($1,$2,$3,$4)",
    [
      responseId,
      versionId,
      sample < 2 ? "repeat@example.test" : "other@example.test",
      `2026-10-0${versionId === fixtureId("survey:v1") ? 1 : 3}T09:0${sample}:00Z`,
    ],
  );
  for (const question of questions) {
    const questionId = fixtureId(`${versionId}:${question.key}`);
    const answerId = fixtureId(`${responseId}:${question.key}`);
    const blank = !question.required && sample === 0;
    let text: string | null = null;
    let date: string | null = null;
    let integer: number | null = null;
    switch (question.type) {
      case "short_text":
        text = sample === 1 ? "=SUM(1,2)" : "José 李 — sample";
        break;
      case "long_text":
        text = blank
          ? null
          : 'First line, "quoted"\nSecond line <script>alert("sample")</script>';
        break;
      case "date":
        date = blank ? null : "2024-02-29";
        break;
      case "linear_scale":
        integer = sample % 2 === 0 ? question.min : question.max;
        break;
      case "dropdown":
      case "multi_select":
      case "multiple_choice":
      case "checkboxes":
        break;
    }
    await client.query(
      "INSERT INTO answers (id,response_id,form_version_id,question_id,question_type,text_value,date_value,integer_value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        answerId,
        responseId,
        versionId,
        questionId,
        question.type,
        text,
        date,
        integer,
      ],
    );
    if ("options" in question && !blank) {
      const selectedPositions =
        question.type === "multi_select"
          ? [2, 0]
          : [sample % question.options.length];
      for (const [
        selectionPosition,
        optionPosition,
      ] of selectedPositions.entries()) {
        await client.query(
          "INSERT INTO answer_selections (answer_id,question_id,question_type,option_id,selection_position) VALUES ($1,$2,$3,$4,$5)",
          [
            answerId,
            questionId,
            question.type,
            fixtureId(`${questionId}:option${optionPosition}`),
            selectionPosition,
          ],
        );
      }
    }
  }
}

// Caller owns the transaction: partial fixtures must never be committed.
export async function seedFixtures(
  client: PoolClient,
): Promise<"created" | "already present"> {
  await client.query("SELECT pg_advisory_xact_lock(3032026)");
  const existing = await client.query<{ count: number }>(
    "SELECT ((SELECT count(*) FROM users WHERE id=ANY($1::uuid[])) + (SELECT count(*) FROM forms WHERE id=ANY($2::uuid[])))::int AS count",
    [
      [fixtureId("alpha"), fixtureId("beta")],
      ["survey", "draft", "acknowledgment", "archived"].map(fixtureId),
    ],
  );
  const count = existing.rows[0]?.count;
  if (count === 6) return "already present";
  if (count !== 0)
    throw new Error(
      "Partial seed roots found. Inspect the existing fixtures; no data was changed.",
    );

  for (const owner of ["alpha", "beta"]) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(demoPassword, salt, 64, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString("hex");
    await client.query(
      "INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,'2026-09-30T08:00:00Z')",
      [
        fixtureId(owner),
        `owner.${owner}@example.test`,
        `scrypt$32768$8$1$${salt}$${hash}`,
      ],
    );
  }
  for (const [form, owner] of [
    ["survey", "alpha"],
    ["draft", "alpha"],
    ["acknowledgment", "beta"],
    ["archived", "beta"],
  ] as const) {
    await client.query(
      "INSERT INTO forms (id,owner_id,slug,created_at) VALUES ($1,$2,$3,'2026-09-30T09:00:00Z')",
      [fixtureId(form), fixtureId(owner), `demo-${form}`],
    );
  }
  for (const version of [1, 2]) {
    const questions = surveyQuestions(version);
    const versionId = await insertVersion(
      client,
      "survey",
      version,
      `Team survey v${version}`,
      questions,
    );
    for (let sample = 0; sample < (version === 1 ? 2 : 4); sample++)
      await insertResponse(client, versionId, questions, sample);
  }
  await client.query(
    "INSERT INTO form_drafts (form_id,definition) VALUES ($1,$2)",
    [
      fixtureId("draft"),
      JSON.stringify({ title: "", description: null, questions: [] }),
    ],
  );
  const acknowledgment: Question[] = [
    {
      key: "agree",
      label: "I acknowledge the instructions",
      type: "checkboxes",
      required: true,
      options: ["I agree"],
    },
  ];
  await insertVersion(
    client,
    "acknowledgment",
    1,
    "Acknowledgment (no responses)",
    acknowledgment,
  );
  const archivedQuestions: Question[] = [
    {
      key: "name",
      label: "Historical feedback",
      type: "short_text",
      required: true,
    },
  ];
  const archivedVersion = await insertVersion(
    client,
    "archived",
    1,
    "Archived feedback",
    archivedQuestions,
  );
  await insertResponse(client, archivedVersion, archivedQuestions, 0);
  await client.query(
    "UPDATE forms SET is_published=true WHERE id=ANY($1::uuid[])",
    [[fixtureId("survey"), fixtureId("acknowledgment")]],
  );
  await client.query(
    "UPDATE forms SET deleted_at='2026-10-04T08:00:00Z' WHERE id=$1",
    [fixtureId("archived")],
  );
  await client.query(
    "INSERT INTO form_webhooks (form_id,url,secret) VALUES ($1,$2,$3)",
    [
      fixtureId("survey"),
      "http://localhost:4001/webhooks",
      "demo-webhook-secret-local-only",
    ],
  );
  return "created";
}
