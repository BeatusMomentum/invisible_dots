/**
 * The address of the Computer page and what it says. The address holds everything (`computer?view=files&path=/home/dot/memory&file=fares.md`),
 * so a link into a folder, a reload and the back button all land where the person was, and the old Browser
 * identities address has somewhere to redirect to.
 */

export const COMPUTER_VIEWS = ["screen", "browser", "files", "usage"] as const;
export type ComputerSection = (typeof COMPUTER_VIEWS)[number];

export const COMPUTER_VIEW_LABELS: Record<ComputerSection, string> = { screen: "Screen", browser: "Browser", files: "Files", usage: "Usage" };

export interface ComputerQuery {
  view: ComputerSection;
  /** Files: the folder to list, as the address has it (absolute, `~`, or relative to home); null for home. */
  path: string | null;
  /** Files: the name of the file of that folder that is open; null for none. */
  file: string | null;
}

type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? null : first;
}

export function parseComputerQuery(params: Params): ComputerQuery {
  const view = COMPUTER_VIEWS.find((candidate) => candidate === one(params.view)) ?? "screen";
  // Folder and file belong to the Files view only: another view carries neither, so a stale address cannot leak one.
  return view === "files" ? { view, path: one(params.path), file: one(params.file) } : { view, path: null, file: null };
}

/** The address of a Dot's Computer page with `query`, leaving out what is the default. */
export function computerHref(dotId: string, query: Partial<ComputerQuery> = {}): string {
  const base = `/dots/${encodeURIComponent(dotId)}/computer`;
  const search = new URLSearchParams();
  if (query.view && query.view !== "screen") search.set("view", query.view);
  if (query.view === "files") {
    if (query.path) search.set("path", query.path);
    if (query.file) search.set("file", query.file);
  }
  const text = search.toString();
  return text === "" ? base : `${base}?${text}`;
}
