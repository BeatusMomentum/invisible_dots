/**
 * What the Activity page does with a Dot's event log beyond describing a row (`events/view.ts`): which types a choice
 * of families asks the control plane for, what a search matches, and the file an export writes.
 */
import type { StoredEvent } from "@invisible-dots/shared/browser";
import { typesOf, type EventFamily, type EventView } from "./events/view";

/** How many events one request of the page asks for, and how many "Load older" adds. */
export const ACTIVITY_PAGE = 200;

/** The types to ask for when these families are chosen; none chosen is every type, so nothing is asked for by type. */
export function typesFor(families: readonly EventFamily[]): string[] | undefined {
  return families.length === 0 ? undefined : families.flatMap(typesOf);
}

/** Whether a row says every word of the search, in its title, its line, its type or where it came from; case is not told apart. */
export function matchesSearch(view: EventView, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const rendered = `${view.title} ${view.detail} ${view.type} ${view.via ?? ""}`.toLowerCase();
  return words.every((word) => rendered.includes(word));
}

/** The events as JSON Lines, oldest first, each as the control plane stored it. */
export function toJsonl(events: readonly StoredEvent[]): string {
  return [...events]
    .sort((a, b) => a.id - b.id)
    .map((event) => JSON.stringify(event))
    .join("\n")
    .concat(events.length > 0 ? "\n" : "");
}

/** The name of the file an export of these events is saved as. */
export function exportName(dotId: string, events: readonly StoredEvent[]): string {
  if (events.length === 0) return `${dotId}-events.jsonl`;
  const first = events.reduce((least, event) => Math.min(least, event.id), Infinity);
  const last = events.reduce((most, event) => Math.max(most, event.id), 0);
  return `${dotId}-events-${first}-${last}.jsonl`;
}
