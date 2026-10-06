import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../lib/dot-title";
import { MemoryView } from "../../../../../components/memory/MemoryView";
import { parseMemoryQuery } from "../../../../../lib/memory-view";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Memory");
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <MemoryView query={parseMemoryQuery(await searchParams)} />;
}
