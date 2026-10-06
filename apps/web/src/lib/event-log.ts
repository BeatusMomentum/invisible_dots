/**
 * Reading a Dot's event log through the one route that serves it, `GET /api/dots/:id/events`, which keeps the types
 * a caller names in the database (`types`) so only those cross the wire. This is the one function that pages through
 * it: the Tasks page and the chat each say which types they read and, where a type alone is not enough, what else
 * an event must be. A view that needs only what happened lately reads the newest window of the log instead
 * (`readRecentEvents`), never the whole of it; the Activity page goes on from there, older, a page at a time, with
 * the same function and a `before`.
 */
import type { InvisibleDotsClient } from "@invisible-dots/sdk";
import { MAX_EVENT_PAGE } from "@invisible-dots/shared/browser";
import type { StoredEvent } from "./types";

export interface EventLogQuery {
  /** The event type names to read; the control plane refuses a name it does not know. */
  types: readonly string[];
  /** Narrows the `tool.called` events to those of these tools (`data.tool`), in the database; other types are not affected. */
  tools?: readonly string[];
  /** For what a type alone cannot say (a `tool.called` of the chat is one that names no task). */
  keep?: (event: StoredEvent) => boolean;
}

/** Every event of the Dot's log of those types that `keep` accepts, oldest first. The log is read page by page from its start. */
export async function readEventLog(client: Pick<InvisibleDotsClient, "events">, dotId: string, query: EventLogQuery): Promise<StoredEvent[]> {
  const found: StoredEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await client.events(dotId, { after, limit: MAX_EVENT_PAGE, types: query.types, tools: query.tools });
    for (const event of page) if (query.keep?.(event) ?? true) found.push(event);
    if (page.length < MAX_EVENT_PAGE) return found;
    after = page[page.length - 1]!.id;
  }
}

/**
 * The newest `count` events of the log that the types and tools keep, oldest first, in one request: what a view that
 * follows the recent past reads, so the cost does not grow with the age of the Dot. `keep` then drops, from those, what
 * the filters cannot say. With `before` (the id of the oldest event already read) it is the `count` events that came
 * before that one.
 */
export async function readRecentEvents(
  client: Pick<InvisibleDotsClient, "events">,
  dotId: string,
  query: EventLogQuery & { count: number; before?: number },
): Promise<StoredEvent[]> {
  const page = await client.events(dotId, { limit: Math.min(query.count, MAX_EVENT_PAGE), types: query.types, tools: query.tools, before: query.before, order: "desc" });
  return page.filter((event) => query.keep?.(event) ?? true).reverse();
}

/** Merge new events into a list ordered by id, dropping duplicates (a reconnect can replay some, and a page can overlap the live stream). */
export function mergeEvents(current: readonly StoredEvent[], incoming: readonly StoredEvent[]): StoredEvent[] {
  const byId = new Map<number, StoredEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
