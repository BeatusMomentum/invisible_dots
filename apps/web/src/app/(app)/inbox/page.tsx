import type { Metadata } from "next";
import { InboxView } from "../../../components/inbox/InboxView";
import { parseInboxQuery } from "../../../lib/inbox";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <InboxView query={parseInboxQuery(await searchParams)} />;
}
