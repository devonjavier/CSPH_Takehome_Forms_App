// Browser-safe contract: no database, environment, or other server imports.
// Array order defines draft position; IDs survive editing and reordering.
export const questionTypes = [
  "short_text",
  "long_text",
  "date",
  "dropdown",
  "multi_select",
  "multiple_choice",
  "checkboxes",
  "linear_scale",
] as const;
export type QuestionType = (typeof questionTypes)[number];
export type DraftOption = { id: string; label: string };
export type DraftQuestion = { id: string; label: string; required: boolean } & (
  | { type: "short_text" | "long_text" | "date" }
  | {
      type: "dropdown" | "multi_select" | "multiple_choice" | "checkboxes";
      options: DraftOption[];
    }
  | {
      type: "linear_scale";
      min: number | null;
      max: number | null;
      minLabel: string;
      maxLabel: string;
    }
);
export type DraftDefinition = {
  title: string;
  description: string | null;
  questions: DraftQuestion[];
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Send a draft object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || value.length > limit)
    throw new Error(`${name} must be text with at most ${limit} characters.`);
  return value;
}
export function isQuestionType(value: unknown): value is QuestionType {
  return questionTypes.some((type) => type === value);
}
export function changeQuestionType(
  question: DraftQuestion,
  type: QuestionType,
): DraftQuestion {
  const common = {
    id: question.id,
    label: question.label,
    required: question.required,
  };
  switch (type) {
    case "short_text":
    case "long_text":
    case "date":
      return { ...common, type };
    case "dropdown":
    case "multi_select":
    case "multiple_choice":
    case "checkboxes":
      return { ...common, type, options: [] };
    case "linear_scale":
      return { ...common, type, min: 1, max: 5, minLabel: "", maxLabel: "" };
  }
}
export function parseDraft(value: unknown): DraftDefinition {
  const draft = record(value);
  if (!Array.isArray(draft.questions) || draft.questions.length > 100)
    throw new Error("A draft may contain at most 100 questions.");
  const ids = new Set<string>();
  function identity(value: unknown): string {
    if (typeof value !== "string" || !uuid.test(value))
      throw new Error("Question and option IDs must be UUIDs.");
    const id = value.toLowerCase();
    if (ids.has(id))
      throw new Error(
        "Question and option IDs must be distinct within the draft.",
      );
    ids.add(id);
    return id;
  }
  function endpoint(value: unknown): number | null {
    if (value === null) return null;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      Math.abs(value) > 2147483647
    )
      throw new Error("Scale endpoints must be integers or blank.");
    return value;
  }
  return {
    title: text(draft.title, "Title", 500),
    description:
      draft.description === null
        ? null
        : text(draft.description, "Description", 10000),
    questions: draft.questions.map((value: unknown): DraftQuestion => {
      const question = record(value);
      if (
        !isQuestionType(question.type) ||
        typeof question.required !== "boolean"
      )
        throw new Error(
          "Each question needs a supported type and a required flag.",
        );
      const common = {
        id: identity(question.id),
        label: text(question.label, "Question label", 1000),
        required: question.required,
      };
      switch (question.type) {
        case "short_text":
        case "long_text":
        case "date":
          return { ...common, type: question.type };
        case "dropdown":
        case "multi_select":
        case "multiple_choice":
        case "checkboxes": {
          if (!Array.isArray(question.options) || question.options.length > 100)
            throw new Error(
              "Option questions need an options array with at most 100 entries.",
            );
          return {
            ...common,
            type: question.type,
            options: question.options.map((value: unknown) => {
              const option = record(value);
              return {
                id: identity(option.id),
                label: text(option.label, "Option label", 1000),
              };
            }),
          };
        }
        case "linear_scale":
          return {
            ...common,
            type: question.type,
            min: endpoint(question.min),
            max: endpoint(question.max),
            minLabel: text(question.minLabel ?? "", "Minimum label", 1000),
            maxLabel: text(question.maxLabel ?? "", "Maximum label", 1000),
          };
      }
    }),
  };
}
