"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { describeEvent, mergeEvents } from "../lib/timeline";
import type { StoredEvent } from "../lib/types";
import { useDot } from "./DotShell";
import { useLiveEvents } from "./events";
import { ErrorBox } from "./ui";

const PAGE_SIZE = 200;

export function TimelineTab() {
  const { dotId } = useDot();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  // Where the next page starts. Kept apart from live events: a live event with a
  // high id must not make "load more" skip the history between the two.
  const cursor = useRef(0);

  // `?after=` pages forward from the oldest event.
  const loadPage = useCallback(
    async (after: number) => {
      setLoading(true);
      try {
        const page = await api.events(dotId, { after, limit: PAGE_SIZE });
        cursor.current = page.at(-1)?.id ?? after;
        setEvents((current) => mergeEvents(current, page));
        setHasMore(page.length >= PAGE_SIZE);
        setError(null);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [dotId],
  );

  useEffect(() => {
    setEvents([]);
    cursor.current = 0;
    void loadPage(0);
  }, [loadPage]);

  useLiveEvents((event) => {
    setEvents((current) => mergeEvents(current, [event]));
  });

  const entries = events.map(describeEvent);
  if (newestFirst) entries.reverse();

  return (
    <>
      <div className="toolbar">
        <h2>Timeline</h2>
        <label className="inline">
          <input type="checkbox" checked={newestFirst} onChange={(e) => setNewestFirst(e.target.checked)} /> Newest first
        </label>
      </div>
      <ErrorBox error={error} title="Could not load events" />
      {!loading && events.length === 0 && !error ? <p className="muted">No events yet.</p> : null}
      <ol className="timeline" aria-live="polite">
        {entries.map((entry) => (
          <li key={entry.id} className={`timeline-item tone-border-${entry.tone}`}>
            <div className="timeline-head">
              <span className="timeline-title">{entry.title}</span>
              <code className="muted small">{entry.type}</code>
              <span className="muted small">{entry.source}</span>
              <time className="muted small" dateTime={entry.at}>
                {formatDate(entry.at)}
              </time>
            </div>
            {entry.detail ? <div className="timeline-detail">{entry.detail}</div> : null}
          </li>
        ))}
      </ol>
      {hasMore ? (
        <div className="actions">
          <button type="button" className="secondary" disabled={loading} onClick={() => void loadPage(cursor.current)}>
            {loading ? "Loading..." : "Load more"}
          </button>
        </div>
      ) : null}
    </>
  );
}
