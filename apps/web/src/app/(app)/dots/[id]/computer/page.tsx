import type { Metadata } from "next";
import { ComputerView } from "../../../../../components/computer/ComputerView";
import { parseComputerQuery } from "../../../../../lib/computer-view";

export const metadata: Metadata = { title: "Computer" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ComputerView query={parseComputerQuery(await searchParams)} />;
}
