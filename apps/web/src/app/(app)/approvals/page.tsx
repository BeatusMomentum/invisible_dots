import { redirect } from "next/navigation";
import { inboxHref } from "../../../lib/inbox";

/** The approvals of every Dot are the Inbox's first tab. */
export default function ApprovalsPage() {
  redirect(inboxHref());
}
