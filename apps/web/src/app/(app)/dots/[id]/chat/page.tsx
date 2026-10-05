import type { Metadata } from "next";
import { ChatTab } from "../../../../../components/ChatTab";

export const metadata: Metadata = { title: "Chat" };

export default function Page() {
  return <ChatTab />;
}
