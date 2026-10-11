import { ResponseView } from "../../response-view";

export default async function Page({
  params,
}: {
  params: Promise<{ formId: string }>;
}) {
  const { formId } = await params;
  return <ResponseView key={formId} formId={formId} />;
}
