"use client";

import { PauseIcon } from "lucide-react";
import { api } from "../../lib/api";
import { automationsNote } from "../../lib/computer";
import { useNow } from "../../lib/use-now";
import { cn } from "../../lib/utils";
import { TONE_CLASS } from "../dot/tone";
import { useLiveRefresh } from "../events";
import { useResource } from "../ui";

/** What changes the host's record the note reads: the computer's state, and the next run the engine reports. */
const NOTE_EVENTS = ["computer.state", "computer.started", "computer.stopped", "automation.next_run"];

/**
 * What the Dot's automations are doing: paused because the person stopped the computer, or when the next one is due.
 * It reads the host's record of the computer, which holds both while the computer is off, when the guest cannot be
 * asked, and it says nothing until that record is read (or when it cannot be).
 */
export function AutomationsNote({ dotId, className }: { dotId: string; className?: string }) {
  const computer = useResource(() => api.computer(dotId), `automations-note:${dotId}`);
  useLiveRefresh(computer.reload, NOTE_EVENTS);
  // "in 5m" counts down with the clock.
  const now = useNow(30_000);
  if (computer.data === undefined) return null;
  const note = automationsNote(computer.data, now);
  return (
    <p role="status" data-paused={note.paused} className={cn("flex items-start gap-2 text-sm", note.paused ? cn("rounded-lg px-3 py-2", TONE_CLASS.warn) : "text-muted-foreground", className)}>
      {note.paused ? <PauseIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
      <span>{note.text}</span>
    </p>
  );
}
