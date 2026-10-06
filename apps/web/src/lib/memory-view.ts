/**
 * The address of the Memory page and what it says. The view and the open note are in the address
 * (`memory?view=notes&note=trips/rome.md`), so a note can be linked, a reload lands on it and the back button walks
 * back; the chat's "Remembered" chip links to the note it names.
 */

export const MEMORY_VIEWS = ["notes", "automations"] as const;
export type MemorySection = (typeof MEMORY_VIEWS)[number];

export const MEMORY_VIEW_LABELS: Record<MemorySection, string> = { notes: "Notes", automations: "Automations" };

export interface MemoryQuery {
  view: MemorySection;
  /** Notes: the key of the note that is open (its path under the memory folder); null for none. */
  note: string | null;
}

type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? null : first;
}

export function parseMemoryQuery(params: Params): MemoryQuery {
  const view = MEMORY_VIEWS.find((candidate) => candidate === one(params.view)) ?? "notes";
  // An open note belongs to the Notes view only: another view carries none, so a stale address cannot leak one.
  return { view, note: view === "notes" ? one(params.note) : null };
}

/** The address of a Dot's Memory page with `query`, leaving out what is the default. */
export function memoryHref(dotId: string, query: Partial<MemoryQuery> = {}): string {
  const base = `/dots/${encodeURIComponent(dotId)}/memory`;
  const search = new URLSearchParams();
  if (query.view && query.view !== "notes") search.set("view", query.view);
  if (query.view !== "automations" && query.note) search.set("note", query.note);
  const text = search.toString();
  return text === "" ? base : `${base}?${text}`;
}
