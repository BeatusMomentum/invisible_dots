/**
 * Reading a Dot's event log through the one route that serves it, `GET /api/dots/:id/events`, which keeps the types
 * a caller names in the database (`types`) so only those cross the wire. This is the one function that pages through
 * it: the Tasks page and the chat each say which types they read and, where a type alone is not enough, what else
 * an event must be.
 */
import type { InvisibleDotsClient } from "@invisible-dots/sdk";
import { MAX_EVENT_PAGE } from "@invisible-dots/shared/browser";
import type { StoredEvent } from "./types";

export interface EventLogQuery {
  /** The event type names to read; the control plane refuses a name it does not know. */
  types: readonly string[];
  /** For what a type alone cannot say (a `tool.called` of the chat is one that names no task). */
  keep?: (event: StoredEvent) => boolean;
}

/** Every event of the Dot's log of those types that `keep` accepts, oldest first. The log is read page by page from its start. */
export async function readEventLog(client: Pick<InvisibleDotsClient, "events">, dotId: string, query: EventLogQuery): Promise<StoredEvent[]> {
  const found: StoredEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await client.events(dotId, { after, limit: MAX_EVENT_PAGE, types: query.types });
    for (const event of page) if (query.keep?.(event) ?? true) found.push(event);
    if (page.length < MAX_EVENT_PAGE) return found;
    after = page[page.length - 1]!.id;
  }
}
