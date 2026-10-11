import type { DraftDefinition } from "./draft.js";
export type Submission = {
  formVersionId: string;
  email: string;
  answers: { questionId: string; value: unknown }[];
};
export type ValidatedAnswer = { questionId: string } & (
  | { type: "short_text" | "long_text" | "date"; value: string | null }
  | { type: "linear_scale"; value: number | null }
  | {
      type: "dropdown" | "multiple_choice" | "multi_select" | "checkboxes";
      value: string[];
    }
);
export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new SubmissionError(
      "Send a valid question, option or version ID.",
      field,
    );
  return value.toLowerCase();
}
function validText(value: string) {
  // PostgreSQL text cannot store NUL; reject unpaired UTF-16 surrogates rather
  // than silently replacing respondent text during encoding.
  return !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);
}
export function parseSubmission(value: unknown): Submission {
  if (
    !record(value) ||
    !Array.isArray(value.answers) ||
    value.answers.length > 100
  )
    throw new SubmissionError(
      "Send an answers array with at most 100 entries.",
      "form",
    );
  if (typeof value.email !== "string")
    throw new SubmissionError("Enter a valid email address.", "email");
  const email = value.email.trim().toLowerCase();
  if (
    email.length > 254 ||
    !validText(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )
    throw new SubmissionError("Enter a valid email address.", "email");
  const seen = new Set<string>();
  return {
    formVersionId: identity(value.formVersionId, "form"),
    email,
    answers: value.answers.map((answer: unknown) => {
      if (!record(answer) || !("value" in answer))
        throw new SubmissionError(
          "Each answer needs a question ID and value.",
          "form",
        );
      const questionId = identity(answer.questionId, "form");
      if (seen.has(questionId))
        throw new SubmissionError("Send each question only once.", questionId);
      seen.add(questionId);
      return { questionId, value: answer.value };
    }),
  };
}
function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0)
  );
}
export function validateAnswers(
  form: DraftDefinition,
  submission: Submission,
): ValidatedAnswer[] {
  const values = new Map(
    submission.answers.map((answer) => [answer.questionId, answer.value]),
  );
  const questionIds = new Set(form.questions.map((question) => question.id));
  for (const questionId of values.keys())
    if (!questionIds.has(questionId))
      throw new SubmissionError(
        "This question does not belong to the published form.",
        "form",
      );
  return form.questions.map((question): ValidatedAnswer => {
    const value = values.get(question.id);
    const fail = (message: string): never => {
      throw new SubmissionError(message, question.id);
    };
    const blank =
      value === undefined ||
      value === null ||
      (typeof value === "string" && !value.trim());
    const common = { questionId: question.id };
    if (
      question.required &&
      (blank || (Array.isArray(value) && value.length === 0))
    )
      fail("Answer this required question.");
    switch (question.type) {
      case "short_text":
      case "long_text": {
        if (blank) return { ...common, type: question.type, value: null };
        if (typeof value !== "string")
          return fail("Enter text for this question.");
        const limit = question.type === "short_text" ? 1000 : 10000;
        if (!validText(value) || value.length > limit)
          return fail(`Enter valid text with at most ${limit} characters.`);
        if (question.type === "short_text" && /[\r\n]/.test(value))
          return fail("Use a single line of text.");
        return { ...common, type: question.type, value };
      }
      case "date":
        if (blank) return { ...common, type: question.type, value: null };
        if (typeof value !== "string" || !isDate(value))
          return fail("Enter a real date in YYYY-MM-DD format.");
        return { ...common, type: question.type, value };
      case "linear_scale":
        if (blank) return { ...common, type: question.type, value: null };
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          question.min === null ||
          question.max === null ||
          value < question.min ||
          value > question.max
        )
          return fail(
            `Enter a whole number from ${question.min} to ${question.max}.`,
          );
        return { ...common, type: question.type, value };
      case "dropdown":
      case "multiple_choice":
      case "multi_select":
      case "checkboxes": {
        if (blank) return { ...common, type: question.type, value: [] };
        const single =
          question.type === "dropdown" || question.type === "multiple_choice";
        if (
          (single && typeof value !== "string") ||
          (!single && !Array.isArray(value))
        )
          return fail(
            single ? "Choose one option." : "Send a list of selected options.",
          );
        const selected: unknown[] = Array.isArray(value) ? value : [value];
        if (selected.length > question.options.length)
          return fail("Too many selected options.");
        const optionIds = new Set(question.options.map((option) => option.id));
        const distinct = new Set<string>();
        const ids = selected.map((option) => {
          const id = identity(option, question.id);
          if (!optionIds.has(id))
            return fail("Choose an option belonging to this question.");
          if (distinct.has(id)) return fail("Choose each option only once.");
          distinct.add(id);
          return id;
        });
        return { ...common, type: question.type, value: ids };
      }
    }
  });
}
