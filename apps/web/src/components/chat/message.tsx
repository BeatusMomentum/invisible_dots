"use client";

import type { ChatMessage } from "../../lib/types";
import { formatDate } from "../../lib/format";
import type { RingState } from "../../lib/attention";
import { relativeTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { Markdown } from "../markdown";
import { DotAvatar } from "../shell/DotAvatar";

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={formatDate(at)} className="text-xs text-muted-foreground">
      {relativeTime(at)}
    </time>
  );
}

/**
 * What the person said: a bubble on the right. `via` says which chat it came through when it was not typed here;
 * `note` says something about it that the log does not (still on its way, waiting for the computer).
 */
export function UserMessage({ text, at, note, via }: { text: string; at?: string; note?: string; via?: string }) {
  return (
    <article aria-label="You" className="flex flex-col items-end gap-1">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-primary-foreground">{text}</p>
      <div className="flex items-center gap-2">
        {via ? <span className="text-xs text-muted-foreground">{via}</span> : null}
        {note ? (
          <span role="status" className="text-xs text-muted-foreground">
            {note}
          </span>
        ) : null}
        {at ? <When at={at} /> : null}
      </div>
    </article>
  );
}

/** What the Dot said: unboxed markdown, with the Dot's face at the first message of a group. */
export function AssistantMessage({ message, dot, ring, firstOfGroup }: { message: ChatMessage; dot: { id: string; name: string }; ring: RingState; firstOfGroup: boolean }) {
  return (
    <article aria-label={dot.name} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <div className="pt-0.5">{firstOfGroup ? <DotAvatar id={dot.id} name={dot.name} ring={ring} size="sm" /> : null}</div>
      <div className={cn("min-w-0 space-y-1")}>
        <Markdown>{message.text}</Markdown>
        {message.created_at ? <When at={message.created_at} /> : null}
      </div>
    </article>
  );
}
