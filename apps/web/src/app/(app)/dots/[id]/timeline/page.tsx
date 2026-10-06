import { redirect } from "next/navigation";

/** The Timeline became the Activity page. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/dots/${encodeURIComponent(id)}/activity`);
}
