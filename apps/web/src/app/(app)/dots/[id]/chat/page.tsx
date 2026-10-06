import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../lib/dot-title";
import { ChatView } from "../../../../../components/chat/ChatView";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Chat");
}

export default function Page() {
  return <ChatView />;
}
