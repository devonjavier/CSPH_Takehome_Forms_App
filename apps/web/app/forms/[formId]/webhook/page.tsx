import { WebhookSettings } from "../../webhook-settings";
export default async function Page({
  params,
}: {
  params: Promise<{ formId: string }>;
}) {
  const { formId } = await params;
  return <WebhookSettings key={formId} formId={formId} />;
}
