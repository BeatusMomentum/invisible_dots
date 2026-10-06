import type { Metadata } from "next";
import { MemoryView } from "../../../../../components/memory/MemoryView";
import { parseMemoryQuery } from "../../../../../lib/memory-view";

export const metadata: Metadata = { title: "Memory" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <MemoryView query={parseMemoryQuery(await searchParams)} />;
}
