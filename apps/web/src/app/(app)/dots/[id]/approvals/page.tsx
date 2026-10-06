import { redirect } from "next/navigation";
import { inboxHref } from "../../../../../lib/inbox";

/** The approvals of one Dot are the Inbox filtered to it. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(inboxHref({ dot: id }));
}
