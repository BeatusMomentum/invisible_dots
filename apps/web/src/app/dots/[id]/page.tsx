import { redirect } from "next/navigation";

export default async function DotIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/dots/${encodeURIComponent(id)}/chat`);
}
