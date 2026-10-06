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

/** Answered approvals, the one answered last first. */
export function historyOrder(items: readonly Approval[]): Approval[] {
  const when = (item: Approval) => Date.parse(item.resolved_at ?? item.created_at);
  return items.filter((item) => item.status !== "pending").sort((a, b) => when(b) - when(a));
}

/** The approvals to list as waiting, the one waiting longest first, followed by those this page saw answered (kept in their place as receipts). */
export function waitingOrder<T extends { createdAt: string; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}
