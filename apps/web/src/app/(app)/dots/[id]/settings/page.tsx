import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../lib/dot-title";
import { DotSettings } from "../../../../../components/dot-settings/DotSettings";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Settings");
}

export default function Page() {
  return <DotSettings />;
}
