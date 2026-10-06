"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { BROWSER_ACTIVITY_EVENT_TYPES, BROWSER_ACTIVITY_TOOLS, BROWSER_ACTIVITY_WINDOW, identityActivity, isBrowserActivityEvent, mergeBrowserEvents, type IdentityActivity } from "../../lib/browser-activity";
import { readRecentEvents } from "../../lib/event-log";
import type { StoredEvent } from "../../lib/types";
import { useNow } from "../../lib/use-now";
import { useLiveEvents } from "../events";

export interface BrowserActivity {
  /** What the log says of one identity right now. */
  of: (identityId: string) => IdentityActivity;
  /** The log could not be read: the page and the "using now" marks are then unknown, not absent. */
  failed: boolean;
}

/**
 * What the Dot does with its browsers: the newest window of the log of its browser calls and of its browsers opening
 * and closing (only those cross the wire, newest first), read once while `wanted` (a Dot with no browser open has
 * nothing to follow) and kept current by the live stream. The
 * clock is renewed every few seconds so that "using now" ends by itself when the calls stop.
 */
export function useBrowserActivity(dotId: string, wanted: boolean): BrowserActivity {
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const now = useNow(5000, wanted);

  useLiveEvents((event) => {
    if (isBrowserActivityEvent(event)) setEvents((current) => mergeBrowserEvents(current, [event]));
  });

  const load = useCallback(() => {
    const mine = ++generation.current;
    readRecentEvents(api, dotId, { types: BROWSER_ACTIVITY_EVENT_TYPES, tools: BROWSER_ACTIVITY_TOOLS, keep: isBrowserActivityEvent, count: BROWSER_ACTIVITY_WINDOW })
      .then((read) => {
        if (mine !== generation.current) return;
        setEvents((current) => mergeBrowserEvents(current, read));
        setFailed(false);
        setLoaded(true);
      })
      .catch(() => {
        if (mine !== generation.current) return;
        setFailed(true);
        setLoaded(true);
      });
  }, [dotId]);

  useEffect(() => {
    if (wanted && !loaded) load();
  }, [wanted, loaded, load]);
  useEffect(() => () => void generation.current++, []);

  return useMemo(() => ({ of: (identityId: string) => identityActivity(events, identityId, now), failed }), [events, now, failed]);
}
