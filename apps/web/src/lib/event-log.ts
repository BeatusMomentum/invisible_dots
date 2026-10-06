/**
 * Reading a Dot's event log through the one route that serves it, `GET /api/dots/:id/events?after=&limit=`, which has
 * no filter by type or task yet (step U2). This is the one function that pages through it, so that changes in one
 * place when the route can filter: the Tasks page and the chat each say which events they keep.
 */
import type { InvisibleDotsClient } from "@invisible-dots/sdk";
import type { StoredEvent } from "./types";

/** The events the control plane stores per page (`MAX_EVENT_PAGE`); a shorter page is the last one. */
const PAGE = 1000;

/** Every event of the Dot's log that `keep` accepts, oldest first. The log is read page by page from its start. */
export async function readEventLog(
  client: Pick<InvisibleDotsClient, "events">,
  dotId: string,
  keep: (event: StoredEvent) => boolean,
  signal?: AbortSignal,
): Promise<StoredEvent[]> {
  const found: StoredEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await client.events(dotId, { after, limit: PAGE });
    if (signal?.aborted) return found;
    for (const event of page) if (keep(event)) found.push(event);
    if (page.length < PAGE) return found;
    after = page[page.length - 1]!.id;
  }
}
