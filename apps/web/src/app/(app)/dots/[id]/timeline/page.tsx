import type { Metadata } from "next";
import { TimelineTab } from "../../../../../components/TimelineTab";

export const metadata: Metadata = { title: "Timeline" };

export default function Page() {
  return (
    <div className="legacy">
      <TimelineTab />
    </div>
  );
}
