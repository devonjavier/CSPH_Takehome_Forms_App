import { parseDraft, type DraftDefinition } from "./draft.js";

export function validatePublication(value: unknown): DraftDefinition {
  const draft = parseDraft(value);
  if (!draft.title.trim())
    throw new Error("Enter a form title before publishing.");
  if (!draft.questions.length)
    throw new Error("Add at least one question before publishing.");
  for (const [index, question] of draft.questions.entries()) {
    const name = `Question ${index + 1}`;
    if (!question.label.trim()) throw new Error(`${name} needs a label.`);
    if ("options" in question) {
      const minimum =
        question.required && question.type !== "checkboxes" ? 2 : 1;
      if (question.options.length < minimum)
        throw new Error(
          `${name} needs at least ${minimum} option${minimum === 1 ? "" : "s"}.`,
        );
      const labels = question.options.map((option) => option.label.trim());
      if (labels.some((label) => !label))
        throw new Error(`${name} has a blank option label.`);
      if (new Set(labels).size !== labels.length)
        throw new Error(`${name} needs distinct option labels after trimming.`);
      // Every possible selection must fit the single-cell XLSX contract.
      if (
        (question.type === "multi_select" || question.type === "checkboxes") &&
        labels.join("\n").length > 32767
      )
        throw new Error(
          `${name} has too much option text for Excel. Shorten the labels so all selections fit within 32,767 characters, including separators.`,
        );
    }
    if (
      question.type === "linear_scale" &&
      (question.min === null ||
        question.max === null ||
        question.min >= question.max)
    )
      throw new Error(
        `${name} needs integer scale endpoints with minimum less than maximum.`,
      );
  }
  return draft;
}
