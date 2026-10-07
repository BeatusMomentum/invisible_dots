import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../lib/dot-title";
import { ComputerView } from "../../../../../components/computer/ComputerView";
import { parseComputerQuery } from "../../../../../lib/computer-view";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Computer");
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ComputerView query={parseComputerQuery(await searchParams)} />;
}
