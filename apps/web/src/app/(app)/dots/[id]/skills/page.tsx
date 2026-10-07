import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../lib/dot-title";
import { SkillsView } from "../../../../../components/skills/SkillsView";
import { parseSkillsQuery } from "../../../../../lib/skills-view";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Skills");
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <SkillsView query={parseSkillsQuery(await searchParams)} />;
}
