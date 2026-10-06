import type { Metadata } from "next";
import { ChannelsView } from "../../../../../components/channels/ChannelsView";

export const metadata: Metadata = { title: "Channels" };

export default function Page() {
  return <ChannelsView />;
}
