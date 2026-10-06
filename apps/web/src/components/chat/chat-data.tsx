"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { buildThread, CHAT_ACTIVITY_EVENT_TYPES, isChatActivityEvent, mergeChatEvents, unsettled, type PendingMessage, type ThreadItem } from "../../lib/chat-thread";
import { readEventLog } from "../../lib/event-log";
import { CHAT_EVENT_TYPES } from "../../lib/messages";
import type { ChatMessage, StoredEvent } from "../../lib/types";
import { useLiveEvents, useLiveRefresh } from "../events";
import { useResource, type Resource } from "../ui";

export type ActivityStatus = "loading" | "loaded" | "failed";

export interface Chat {
  messages: Resource<ChatMessage[]>;
  thread: ThreadItem[];
  /** Messages sent from this page that the log does not hold yet, oldest first. */
  pending: PendingMessage[];
  /** The logged messages that were stored while the computer had to wake up, until the Dot picks up its work. */
  queued: ReadonlySet<number>;
  activity: { status: ActivityStatus; error: unknown; retry: () => void };
  /** Send a message; resolves with the error when it was not accepted, null when it was. */
  send: (text: string) => Promise<unknown>;
  sending: boolean;
}

const WAKES_THE_DOT = ["agent.state", "message.assistant"];

/**
 * Everything the chat shows, kept current by the live stream: the conversation (the messages route), what the Dot did
 * between its messages (the event log, read once and then followed live), and what the person has just sent. A sent
 * message shows at once and is replaced by the logged one, which the API names by its event id.
 */
export function useChat(dotId: string): Chat {
  const messages = useResource(() => api.messages(dotId), `messages:${dotId}`);
  useLiveRefresh(messages.reload, CHAT_EVENT_TYPES);

  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [status, setStatus] = useState<ActivityStatus>("loading");
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);

  useLiveEvents((event) => {
    if (isChatActivityEvent(event)) setEvents((current) => mergeChatEvents(current, [event]));
  });

  const load = useCallback(() => {
    const mine = ++generation.current;
    setStatus("loading");
    readEventLog(api, dotId, { types: CHAT_ACTIVITY_EVENT_TYPES })
      .then((read) => {
        if (mine !== generation.current) return;
        setEvents((current) => mergeChatEvents(current, read));
        setError(null);
        setStatus("loaded");
      })
      .catch((failure: unknown) => {
        if (mine !== generation.current) return;
        setError(failure);
        setStatus("failed");
      });
  }, [dotId]);
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const [sent, setSent] = useState<PendingMessage[]>([]);
  const [queued, setQueued] = useState<ReadonlySet<number>>(new Set());
  const [sending, setSending] = useState(false);
  const counter = useRef(0);
  useLiveEvents(() => setQueued((current) => (current.size === 0 ? current : new Set())), WAKES_THE_DOT);

  const logged = messages.data;
  const pending = useMemo(() => unsettled(sent, logged ?? []), [sent, logged]);
  // What the log holds now is no longer pending: forget it, so the list does not grow for as long as the page is open.
  useEffect(() => {
    if (pending.length !== sent.length) setSent(pending);
  }, [pending, sent.length]);

  const send = useCallback(
    async (text: string): Promise<unknown> => {
      const key = `sent-${++counter.current}`;
      setSent((current) => [...current, { key, text, eventId: null }]);
      setSending(true);
      try {
        const answer = await api.sendMessage(dotId, text);
        setSent((current) => current.map((p) => (p.key === key ? { ...p, eventId: answer.event_id } : p)));
        if (answer.delivery === "queued") setQueued((current) => new Set(current).add(answer.event_id));
        messages.reload();
        return null;
      } catch (failure) {
        setSent((current) => current.filter((p) => p.key !== key));
        return failure;
      } finally {
        setSending(false);
      }
    },
    [dotId, messages.reload],
  );

  const thread = useMemo(() => buildThread(logged ?? [], events), [logged, events]);
  return { messages, thread, pending, queued, activity: { status, error, retry: load }, send, sending };
}
