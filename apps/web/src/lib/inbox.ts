/**
 * The Inbox's address and what it filters by. The address says everything (`/inbox?tab=history&dot=fares&permission=files.write`),
 * so a link to a Dot's approvals, a reload and the back button all land where the person was.
 */
import type { Approval } from "./types";

export type InboxTab = "needs-you" | "history";

export interface InboxQuery {
  tab: InboxTab;
  /** A Dot's id or name; null for every Dot. */
  dot: string | null;
  /** A permission name; null for every permission. */
  permission: string | null;
}

type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? null : first;
}

export function parseInboxQuery(params: Params): InboxQuery {
  return { tab: one(params.tab) === "history" ? "history" : "needs-you", dot: one(params.dot), permission: one(params.permission) };
}

/** The address of the Inbox with `query`, leaving out what is the default. */
export function inboxHref(query: Partial<InboxQuery> = {}): string {
  const search = new URLSearchParams();
  if (query.tab === "history") search.set("tab", "history");
  if (query.dot) search.set("dot", query.dot);
  if (query.permission) search.set("permission", query.permission);
  const text = search.toString();
  return text === "" ? "/inbox" : `/inbox?${text}`;
}

/** The id a `dot` filter names: a Dot's id, or its name; a value that names no Dot is kept as it is (a deleted Dot's approvals can still be asked for). */
export function resolveDotFilter(filter: string | null, dots: readonly { id: string; name: string }[]): string | null {
  if (filter === null) return null;
  return dots.find((dot) => dot.id === filter)?.id ?? dots.find((dot) => dot.name === filter)?.id ?? filter;
}

/** Whether a thing of this Dot and permission passes the filters; `dotId` is already resolved. */
export function matchesFilters(dotId: string | null, permission: string | null, itemDotId: string, itemPermission: string): boolean {
  return (dotId === null || itemDotId === dotId) && (permission === null || itemPermission === permission);
}

/** How many answered approvals History asks the control plane for at a time. */
export const HISTORY_PAGE = 50;

/** The answered approvals History holds, the one answered last first as the control plane lists them, and where the next page goes on. */
export interface HistoryRows {
  rows: readonly Approval[];
  /** The id of the last approval of the oldest page held, which the next page goes on after; null when the list has ended. */
  cursor: string | null;
}

/**
 * What History holds after the newest page was read. When that page reaches into the rows already held (or is the whole
 * list) they stay below it with their cursor; when it does not, more was answered since than a page holds and what is
 * held is no longer next to the new rows, so only the page is kept and the older ones are read again on request.
 */
export function newestHistoryPage(held: HistoryRows | undefined, page: readonly Approval[]): HistoryRows {
  const last = page.length === HISTORY_PAGE ? page[page.length - 1]!.id : null;
  if (held === undefined || held.rows.length === 0) return { rows: page, cursor: last };
  if (page.length < HISTORY_PAGE) return { rows: page, cursor: null };
  const heldIds = new Set(held.rows.map((row) => row.id));
  if (!page.some((row) => heldIds.has(row.id))) return { rows: page, cursor: last };
  const pageIds = new Set(page.map((row) => row.id));
  return { rows: [...page, ...held.rows.filter((row) => !pageIds.has(row.id))], cursor: held.cursor };
}

/** What History holds after the page that goes on from its cursor was read. */
export function olderHistoryPage(held: HistoryRows, page: readonly Approval[]): HistoryRows {
  const heldIds = new Set(held.rows.map((row) => row.id));
  return { rows: [...held.rows, ...page.filter((row) => !heldIds.has(row.id))], cursor: page.length === HISTORY_PAGE ? page[page.length - 1]!.id : null };
}

/** The approvals to list as waiting, the one waiting longest first, followed by those this page saw answered (kept in their place as receipts). */
export function waitingOrder<T extends { createdAt: string; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}
