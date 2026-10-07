/**
 * The address of the Skills page and what a skill's file shows. The open skill is in the address
 * (`skills?skill=shop-login`), so it can be linked, and a reload or the back button lands on it.
 */

type Params = Record<string, string | string[] | undefined>;

export interface SkillsQuery {
  /** The name of the skill that is open; null for none. */
  skill: string | null;
}

export function parseSkillsQuery(params: Params): SkillsQuery {
  const value = Array.isArray(params.skill) ? params.skill[0] : params.skill;
  return { skill: value === undefined || value === "" ? null : value };
}

/** The address of a Dot's Skills page, with one skill open or none. */
export function skillsHref(dotId: string, skill: string | null = null): string {
  const base = `/dots/${encodeURIComponent(dotId)}/skills`;
  return skill === null ? base : `${base}?${new URLSearchParams({ skill }).toString()}`;
}

/** A skill's file without its frontmatter: the name and the description are shown above it already. */
export function skillBody(content: string): string {
  return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trimStart();
}
