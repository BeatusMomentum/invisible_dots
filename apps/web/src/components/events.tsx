"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { StoredEvent } from "../lib/types";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

type Listener = (event: StoredEvent) => void;

interface StreamContext {
  subscribe: (listener: Listener) => () => void;
  status: StreamStatus;
  detail: string;
}

const Context = createContext<StreamContext | null>(null);

/** One SSE connection per page, shared by every component below it. */
export function EventStreamProvider({ dotId, children }: { dotId?: string; children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setStatus("connecting");
    setDetail("");
    void (async () => {
      try {
        // The SDK reconnects by itself and resumes after the last event it delivered.
        for await (const event of api.stream({
          dotId,
          signal: controller.signal,
          onOpen: () => {
            setStatus("open");
            setDetail("");
          },
          onReconnect: ({ error }) => {
            setStatus("reconnecting");
            setDetail(error.message);
          },
        })) {
          for (const listener of listeners.current) listener(event);
        }
        setStatus("closed");
      } catch (error) {
        // Only an answer that retrying cannot fix ends the stream (a 4xx such as a refused origin).
        setStatus("closed");
        setDetail((error as Error).message);
      }
    })();
    return () => controller.abort();
  }, [dotId]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const value = useMemo<StreamContext>(() => ({ subscribe, status, detail }), [subscribe, status, detail]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * Call `onEvent` for each live event whose type matches `types` (all when
 * omitted). The latest callback is used without resubscribing.
 */
export function useLiveEvents(onEvent: Listener, types?: readonly string[]): void {
  const subscribe = useContext(Context)?.subscribe;
  const callback = useRef(onEvent);
  useEffect(() => {
    callback.current = onEvent;
  });
  const key = types?.join(",") ?? "";
  useEffect(() => {
    if (!subscribe) return;
    const wanted = key ? new Set(key.split(",")) : null;
    return subscribe((event) => {
      if (!wanted || wanted.has(event.type)) callback.current(event);
    });
  }, [subscribe, key]);
}

/** Like useLiveEvents, but coalesces bursts into one call `delayMs` after the last event. */
export function useLiveRefresh(refresh: () => void, types: readonly string[], delayMs = 300): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useLiveEvents(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), delayMs);
  }, types);
}

export function StreamIndicator() {
  const context = useContext(Context);
  if (!context) return null;
  const label =
    context.status === "open" ? "Live" : context.status === "closed" ? "Offline" : context.status === "connecting" ? "Connecting" : "Reconnecting";
  return (
    <span className={`stream stream-${context.status}`} role="status" title={context.detail || undefined}>
      <span aria-hidden="true" className="stream-dot" />
      {label}
    </span>
  );
}
