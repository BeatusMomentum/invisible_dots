"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "../../lib/use-visible-interval";

export interface Frame {
  /** An object URL of the newest frame; null before the first one and after a change of source. */
  url: string | null;
  /** ISO 8601 time the newest frame arrived. */
  takenAt: string | null;
  /** Why the last attempt failed; null when it did not. The previous frame stays while it is set. */
  error: unknown;
  pending: boolean;
  refresh: () => Promise<void>;
}

/**
 * The newest image of a source that is read again every `intervalMs` while `enabled` and the page is visible. One
 * source is one mounted component: a new source is a new mount (a `key` on it), so nothing of the old one is shown
 * and an answer to it that arrives late is dropped with it. Object URLs are revoked as they are replaced and when
 * the component goes away.
 */
export function useFrame(load: () => Promise<Uint8Array<ArrayBuffer>>, mime: string, intervalMs: number, enabled: boolean): Frame {
  const [url, setUrl] = useState<string | null>(null);
  const [takenAt, setTakenAt] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const current = useRef<string | null>(null);
  const alive = useRef(true);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  const drop = useCallback(() => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      drop();
    };
  }, [drop]);

  const refresh = useCallback(async () => {
    setPending(true);
    try {
      const bytes = await loader.current();
      if (!alive.current) return;
      const next = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = next;
      setUrl(next);
      setTakenAt(new Date().toISOString());
      setError(null);
    } catch (failure) {
      if (alive.current) setError(failure);
    } finally {
      if (alive.current) setPending(false);
    }
  }, [mime]);

  useVisibleInterval(refresh, intervalMs, enabled);
  return { url, takenAt, error, pending, refresh };
}
