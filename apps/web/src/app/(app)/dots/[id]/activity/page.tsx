import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../lib/dot-title";
import { ActivityView } from "../../../../../components/activity/ActivityView";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Activity");
}

export default function Page() {
  return <ActivityView />;
}
