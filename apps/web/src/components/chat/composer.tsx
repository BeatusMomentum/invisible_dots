"use client";

import { ArrowUpIcon } from "lucide-react";
import { useEffect, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const MAX_HEIGHT_PX = 192;

/**
 * Where the person writes. The box grows with the text up to a limit, Enter sends and Shift+Enter starts a new line
 * (Enter while an input method is composing a character does neither). When the person cannot write, the box says
 * why instead of only going grey.
 */
export function Composer({
  value,
  onChange,
  onSend,
  blocked,
  hint,
  sending,
  inputRef,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  /** Why nothing can be sent; null when it can. */
  blocked: string | null;
  hint: string | null;
  sending: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const box = inputRef;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value, box]);

  const text = value.trim();
  const canSend = blocked === null && text !== "" && !sending;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (canSend) onSend(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={submit} className="border-t p-3">
      <div className={cn("mx-auto flex w-full max-w-[760px] items-end gap-2 rounded-lg border bg-background p-2 focus-within:border-ring focus-within:outline-hidden", blocked !== null && "opacity-70")}>
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <Textarea
          id="chat-input"
          ref={box}
          rows={1}
          autoFocus
          disabled={blocked !== null}
          placeholder={blocked ?? "Write a message. Enter sends, Shift+Enter adds a line."}
          aria-describedby={blocked ?? hint ? "chat-input-note" : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-48 min-h-9 resize-none border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:ring-0"
        />
        <Button type="submit" size="icon" disabled={!canSend} aria-label="Send">
          <ArrowUpIcon />
        </Button>
      </div>
      {(blocked ?? hint) ? (
        <p id="chat-input-note" className="mx-auto mt-1.5 w-full max-w-[760px] px-1 text-xs text-muted-foreground">
          {blocked ?? hint}
        </p>
      ) : null}
    </form>
  );
}
