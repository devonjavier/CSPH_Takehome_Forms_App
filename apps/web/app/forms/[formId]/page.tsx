import { DraftEditor } from "../draft-editor";

export default async function EditFormPage({
  params,
}: {
  params: Promise<{ formId: string }>;
}) {
  const { formId } = await params;
  return <DraftEditor formId={formId} />;
}
