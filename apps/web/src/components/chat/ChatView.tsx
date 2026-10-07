"use client";

import { MessageSquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isWorking } from "../../lib/agent";
import { lastStepSinceUser } from "../../lib/chat-thread";
import { viaChannel } from "../../lib/channels";
import { composerState, messageNote, SUGGESTIONS } from "../../lib/chat-view";
import { readDraft, writeDraft } from "../../lib/draft";
import { ComputerPanel } from "../computer/ComputerPanel";
import { useDot } from "../DotShell";
import { useDotRing } from "../dot/use-ring";
import { useDotLive } from "../shell/attention";
import { ErrorAlert } from "../ErrorAlert";
import { Button } from "../ui/button";
import { Activity } from "./activity";
import { useChat } from "./chat-data";
import { Composer } from "./composer";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "./conversation";
import { AssistantMessage, UserMessage } from "./message";
import { WorkingRow } from "./working-row";

/**
 * The message the person has typed and not sent, kept per Dot. `restore` puts a message that was refused back in
 * front of whatever has been typed since, so that nothing of either is lost.
 */
function useDraft(dotId: string): [string, (text: string) => void, (text: string) => void] {
  const [text, setText] = useState("");
  const latest = useRef("");
  const set = (next: string) => {
    latest.current = next;
    setText(next);
    writeDraft(dotId, next);
  };
  useEffect(() => {
    const stored = readDraft(dotId);
    latest.current = stored;
    setText(stored);
  }, [dotId]);
  return [text, set, (refused) => set(latest.current === "" ? refused : `${refused}\n${latest.current}`)];
}

function ChatInner({ dotId }: { dotId: string }) {
  const { dot } = useDot();
  const record = dot.data;
  const chat = useChat(dotId);
  const live = useDotLive(dotId);
  const ring = useDotRing(dotId, record);
  const [draft, setDraft, restoreDraft] = useDraft(dotId);
  const input = useRef<HTMLTextAreaElement>(null);
  const [sendError, setSendError] = useState<unknown>(null);

  const { blocked, hint } = composerState(record);
  const who = { id: dotId, name: record?.name ?? "The Dot" };
  const empty = chat.messages.data !== undefined && chat.thread.length === 0 && chat.pending.length === 0;
  const last = lastStepSinceUser(chat.thread);

  async function send(text: string) {
    setSendError(null);
    setDraft("");
    const failure = await chat.send(text);
    if (failure !== null) {
      // Nothing was lost: the text goes back into the box to be sent again.
      restoreDraft(text);
      setSendError(failure);
    }
  }

  function suggest(text: string) {
    setDraft(text);
    input.current?.focus();
  }

  const column = (
    <>
      <Conversation className="min-h-0 flex-1" aria-label="Conversation">
        <ConversationContent>
          <ErrorAlert error={chat.messages.error} title="Could not load the conversation" />
          {chat.earlier.available ? (
            <div className="flex justify-center">
              <Button type="button" variant="outline" size="sm" disabled={chat.earlier.loading} onClick={chat.earlier.load}>
                {chat.earlier.loading ? "Loading earlier messages..." : "Show earlier messages"}
              </Button>
            </div>
          ) : null}
          <ErrorAlert error={chat.earlier.error} title="Could not load earlier messages" />
          {chat.activity.status === "failed" ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <span>What the Dot did between its messages could not be read: {chat.activity.error instanceof Error ? chat.activity.error.message : String(chat.activity.error)}</span>
              <Button type="button" variant="outline" size="xs" onClick={chat.activity.retry}>
                Try again
              </Button>
            </div>
          ) : null}
          {empty ? (
            <ConversationEmptyState
              icon={<MessageSquareIcon className="size-6" />}
              title={`Say hello to ${who.name}`}
              description="Tell it what you need."
            >
              <ul aria-label="Ways to begin" className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((text) => (
                  <li key={text}>
                    <Button type="button" variant="outline" size="sm" className="h-auto max-w-72 whitespace-normal py-1.5 text-left" onClick={() => suggest(text)}>
                      {text}
                    </Button>
                  </li>
                ))}
              </ul>
            </ConversationEmptyState>
          ) : null}
          {chat.thread.map((item) => {
            switch (item.kind) {
              case "user":
                return <UserMessage key={`m${item.id}`} text={item.message.text} at={item.message.created_at} note={messageNote(item.id, chat.queued)} via={viaChannel(item.message.origin)} />;
              case "assistant":
                return <AssistantMessage key={`m${item.id}`} message={item.message} dot={who} ring={ring} firstOfGroup={item.firstOfGroup} />;
              case "activity":
                return (
                  <div key={`a${item.id}`} className="pl-[2.75rem]">
                    <Activity dotId={dotId} items={item.items} />
                  </div>
                );
            }
          })}
          {chat.pending.map((p) => (
            <UserMessage key={p.key} text={p.text} note={messageNote(p.eventId, chat.queued)} />
          ))}
          {isWorking(live.agent) ? <WorkingRow dot={who} ring={ring} state={live.agent} last={last} /> : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <ErrorAlert error={sendError} title="The message was not sent" />
      <Composer value={draft} onChange={setDraft} onSend={(text) => void send(text)} blocked={blocked} hint={hint} sending={chat.sending} inputRef={input} />
    </>
  );

  const computerState = record?.computer_state ?? null;
  // Side by side from 1024 px, the conversation on the left; below that the computer is a strip above the
  // conversation, as tall as its picture needs. Both reach the bottom of the window: the tab's body is as tall as
  // what is left of it.
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 lg:grid-cols-2 lg:grid-rows-1">
      <div className="order-2 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card lg:order-1">{column}</div>
      <aside aria-label="Computer" className="order-1 flex min-h-0 min-w-0 flex-col rounded-lg border bg-card p-4 lg:order-2">
        <ComputerPanel dotId={dotId} computerState={computerState} />
      </aside>
    </div>
  );
}

/** The chat tab (S5): the conversation with the Dot and what it did to answer, always beside its computer. */
export function ChatView() {
  const { dotId } = useDot();
  // One chat per Dot: moving to another Dot starts from nothing.
  return <ChatInner key={dotId} dotId={dotId} />;
}
