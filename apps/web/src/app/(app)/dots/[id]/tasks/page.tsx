import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../lib/dot-title";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Tasks");
}

/** The list is the layout's: this page is the address with no task open, and adds nothing to it. */
export default function Page() {
  return null;
}
