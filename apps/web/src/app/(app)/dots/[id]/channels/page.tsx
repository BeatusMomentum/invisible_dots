import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../lib/dot-title";
import { ChannelsView } from "../../../../../components/channels/ChannelsView";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Channels");
}

export default function Page() {
  return <ChannelsView />;
}
