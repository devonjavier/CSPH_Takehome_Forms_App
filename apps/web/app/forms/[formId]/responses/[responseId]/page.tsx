import { ResponseView } from "../../../response-view";

export default async function Page({
  params,
}: {
  params: Promise<{ formId: string; responseId: string }>;
}) {
  const { formId, responseId } = await params;
  return (
    <ResponseView
      key={`${formId}/${responseId}`}
      formId={formId}
      responseId={responseId}
    />
  );
}
