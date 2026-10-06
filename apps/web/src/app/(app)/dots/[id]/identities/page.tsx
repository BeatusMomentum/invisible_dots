import { redirect } from "next/navigation";
import { computerHref } from "../../../../../lib/computer-view";

/** The browsers of one Dot are the Browser view of its Computer page. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(computerHref(id, { view: "browser" }));
}
