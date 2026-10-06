"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { typesOf, viewEvent } from "../../lib/events/view";
import { formatDate } from "../../lib/format";
import { relativeTime } from "../../lib/time";
import type { StoredEvent } from "../../lib/types";
import { useNow } from "../../lib/use-now";
import { useLiveEvents } from "../events";

/**
 * What counts as the Dot being active: it was talked to, it answered, it did work, asked, remembered or opened a
 * browser. Its agent changing state, a report of the next automation or a start of its computer say nothing of that.
 */
const ACTIVITY_TYPES = (["chat", "tasks", "tools", "approvals", "memory", "browser"] as const).flatMap(typesOf);

/** The newest thing the Dot did or was asked: one request when the card appears, then the stream. */
function useLastActivity(dotId: string): { event: StoredEvent | null; loading: boolean } {
  const [event, setEvent] = useState<StoredEvent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setEvent(null);
    setLoading(true);
    api
      .events(dotId, { types: ACTIVITY_TYPES, limit: 1, order: "desc" })
      .then(([newest]) => {
        // An event that came live meanwhile is newer than what was read: keep the newer.
        if (live && newest) setEvent((current) => (current !== null && current.id > newest.id ? current : newest));
      })
      .catch(() => {
        // A convenience: the card says nothing of it, as it does while it loads.
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [dotId]);

  useLiveEvents((incoming) => {
    if (incoming.dot_id === dotId) setEvent((current) => (current !== null && current.id > incoming.id ? current : incoming));
  }, ACTIVITY_TYPES);

  return { event, loading };
}

/** "Last activity: a task completed, 5 minutes ago": the card's answer to "is it doing anything?". */
export function LastActivity({ dotId }: { dotId: string }) {
  const { event, loading } = useLastActivity(dotId);
  const now = useNow(60_000);
  if (loading && event === null) return null;
  if (event === null) return <dd className="text-muted-foreground">None yet</dd>;
  return (
    <dd>
      <span title={viewEvent(event).detail || undefined}>{viewEvent(event).title}</span>,{" "}
      <time dateTime={event.created_at} title={formatDate(event.created_at)}>
        {relativeTime(event.created_at, now)}
      </time>
    </dd>
  );
}
