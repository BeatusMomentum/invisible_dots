"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { CHAT_EVENT_TYPES } from "../lib/messages";
import { agentStateLabel, type AgentStateValue } from "../lib/agent";
import { useDot } from "./DotShell";
import { useLiveEvents, useLiveRefresh } from "./events";
import { ErrorBox, useAction, useResource } from "./ui";

export function ChatTab() {
  const { dotId } = useDot();
  const messages = useResource(() => api.messages(dotId), `messages:${dotId}`);
  const [text, setText] = useState("");
  const [agentState, setAgentState] = useState<AgentStateValue | null>(null);
  const send = useAction();
  const endRef = useRef<HTMLDivElement>(null);

  useLiveRefresh(messages.reload, CHAT_EVENT_TYPES);
  useLiveEvents(
    (event) => {
      const state = event.data.state;
      if (typeof state === "string") setAgentState(state as AgentStateValue);
    },
    ["agent.state"],
  );

  const count = messages.data?.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = text.trim();
    if (!body) return;
    const ok = await send.run(() => api.sendMessage(dotId, body));
    if (ok) {
      setText("");
      messages.reload();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter starts a new line.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="chat">
      <ErrorBox error={messages.error} title="Could not load the conversation" />
      <ol className="messages" aria-label="Conversation" aria-live="polite">
        {messages.data?.map((m) => (
          <li key={m.event_id} className={`message message-${m.role}`}>
            <div className="message-meta">
              <span>{m.role === "user" ? "You" : "Dot"}</span>
              {m.created_at ? <time dateTime={m.created_at}>{formatDate(m.created_at)}</time> : null}
            </div>
            <div className="message-text">{m.text}</div>
          </li>
        ))}
      </ol>
      {messages.data && count === 0 ? <p className="muted">No messages yet.</p> : null}
      {agentState && agentState !== "IDLE" ? (
        <p className="muted" role="status">
          {agentStateLabel(agentState)}
        </p>
      ) : null}
      <div ref={endRef} />
      <form className="chat-form" onSubmit={submit}>
        <label htmlFor="chat-input" className="visually-hidden">
          Message
        </label>
        <textarea
          id="chat-input"
          rows={3}
          placeholder="Write a message. Enter sends, Shift+Enter adds a line."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" disabled={send.pending || !text.trim()}>
          {send.pending ? "Sending..." : "Send"}
        </button>
      </form>
      <ErrorBox error={send.error} title="The message was not sent" />
    </div>
  );
}
