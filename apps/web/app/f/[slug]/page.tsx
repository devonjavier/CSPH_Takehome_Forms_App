import { PublicFormPage } from "../public-form";

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <PublicFormPage key={slug} slug={slug} />;
}
