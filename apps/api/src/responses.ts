import type { Pool } from "pg";
import { withTransaction } from "./database.js";
import { HttpError } from "./errors.js";
import { readPublicForm } from "./public-definition.js";
import { validateAnswers, type Submission } from "./contracts/submission.js";
import { parsePublicForm } from "./contracts/draft.js";
import type { WebhookConfig, WebhookJob } from "./webhooks.js";

export function submitResponse(
  pool: Pool,
  slug: string,
  submission: Submission,
) {
  return withTransaction(pool, async (client) => {
    // Same root lock as publish/unpublish/archive. Whichever transaction gets
    // the lock first completes before the next rechecks visibility and version.
    const locked = await client.query<{
      id: string;
      current_version_id: string | null;
      is_published: boolean;
      deleted_at: Date | null;
    }>(
      "SELECT id,current_version_id,is_published,deleted_at FROM forms WHERE slug=$1 FOR UPDATE",
      [slug],
    );
    const form = locked.rows[0];
    if (!form || !form.is_published || form.deleted_at !== null)
      throw new HttpError(
        404,
        "NOT_FOUND",
        "This form is no longer available.",
      );
    if (form.current_version_id !== submission.formVersionId)
      throw new HttpError(
        409,
        "FORM_UPDATED",
        "This form has been updated. Please refresh the page before submitting.",
      );
    const definition = parsePublicForm(await readPublicForm(client, slug));
    const answers = validateAnswers(definition, submission);
    const created = await client.query<{ id: string; submittedAt: Date }>(
      'INSERT INTO responses (form_version_id,email) VALUES ($1,$2) RETURNING id,submitted_at AS "submittedAt"',
      [submission.formVersionId, submission.email],
    );
    const response = created.rows[0];
    if (!response) throw new Error("Response creation failed.");
    for (const answer of answers) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO answers (response_id,form_version_id,question_id,question_type,text_value,date_value,integer_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          response.id,
          submission.formVersionId,
          answer.questionId,
          answer.type,
          answer.type === "short_text" || answer.type === "long_text"
            ? answer.value
            : null,
          answer.type === "date" ? answer.value : null,
          answer.type === "linear_scale" ? answer.value : null,
        ],
      );
      const storedAnswer = inserted.rows[0];
      if (!storedAnswer) throw new Error("Answer creation failed.");
      if (Array.isArray(answer.value) && answer.value.length) {
        await client.query(
          `INSERT INTO answer_selections (answer_id,question_id,question_type,option_id,selection_position)
           SELECT $1,$2,$3,option_id,(position-1)::integer FROM unnest($4::uuid[]) WITH ORDINALITY AS choices(option_id,position)`,
          [storedAnswer.id, answer.questionId, answer.type, answer.value],
        );
      }
    }
    // Snapshot configuration under the same form lock used by settings mutations.
    // A later edit/archive cannot retarget this already accepted submission.
    const config = (
      await client.query<WebhookConfig>(
        "SELECT url,secret FROM form_webhooks WHERE form_id=$1",
        [form.id],
      )
    ).rows[0];
    let webhook: WebhookJob | null = null;
    if (config) {
      const payloadAnswers = definition.questions.map((question) => {
        const answer = answers.find(
          (answer) => answer.questionId === question.id,
        );
        if (!answer) throw new Error("Missing validated answer.");
        let value: string | number | string[] | null = answer.value;
        if (Array.isArray(answer.value) && "options" in question) {
          const labels = answer.value.map((id) => {
            const option = question.options.find((option) => option.id === id);
            if (!option) throw new Error("Missing validated option.");
            return option.label;
          });
          value =
            question.type === "dropdown" || question.type === "multiple_choice"
              ? (labels[0] ?? null)
              : labels;
        }
        return {
          questionId: question.id,
          label: question.label,
          type: question.type,
          value,
        };
      });
      webhook = {
        ...config,
        responseId: response.id,
        payload: {
          form: {
            id: form.id,
            title: definition.title,
            formVersionId: submission.formVersionId,
          },
          response: {
            ...response,
            email: submission.email,
            answers: payloadAnswers,
          },
        },
      };
    }
    return { response, webhook };
  });
}
