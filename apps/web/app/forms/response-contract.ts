import { isRecord } from "../api-client";

export type ResponseSummary = {
  id: string;
  email: string;
  submittedAt: string;
  versionNumber: number;
};
export type ResponseListing = {
  form: { id: string; title: string };
  responses: ResponseSummary[];
  total: number;
  page: number;
  pageSize: number;
};
export type ResponseDetail = ResponseSummary & {
  formVersionId: string;
  title: string;
  description: string | null;
  answers: {
    questionId: string;
    label: string;
    value: string | null;
    selectedOptions: { id: string; label: string }[];
  }[];
};
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Could not read response data.");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Could not read response data.");
  return value;
}
function summary(value: unknown): ResponseSummary {
  if (!isRecord(value)) throw new Error("Could not read response data.");
  return {
    id: text(value.id),
    email: text(value.email),
    submittedAt: text(value.submittedAt),
    versionNumber: number(value.versionNumber),
  };
}
export function readResponseListing(value: unknown): ResponseListing {
  if (
    !isRecord(value) ||
    !isRecord(value.form) ||
    !Array.isArray(value.responses)
  )
    throw new Error("Could not read responses.");
  return {
    form: { id: text(value.form.id), title: text(value.form.title) },
    responses: value.responses.map(summary),
    total: number(value.total),
    page: number(value.page),
    pageSize: number(value.pageSize),
  };
}
export function readResponseDetail(value: unknown): ResponseDetail {
  if (!isRecord(value) || !isRecord(value.response))
    throw new Error("Could not read this response.");
  const response = value.response;
  if (!Array.isArray(response.answers))
    throw new Error("Could not read answers.");
  return {
    ...summary(response),
    formVersionId: text(response.formVersionId),
    title: text(response.title),
    description:
      response.description === null ? null : text(response.description),
    answers: response.answers.map((answer: unknown) => {
      if (!isRecord(answer) || !Array.isArray(answer.selectedOptions))
        throw new Error("Could not read an answer.");
      return {
        questionId: text(answer.questionId),
        label: text(answer.label),
        value: answer.value === null ? null : text(answer.value),
        selectedOptions: answer.selectedOptions.map((option: unknown) => {
          if (!isRecord(option)) throw new Error("Could not read an option.");
          return { id: text(option.id), label: text(option.label) };
        }),
      };
    }),
  };
}
