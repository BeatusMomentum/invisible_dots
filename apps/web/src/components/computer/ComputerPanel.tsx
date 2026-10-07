"use client";

import { computerIsUp } from "@invisible-dots/shared/browser";
import { FrameView } from "./frame-view";

/**
 * The Dot's computer beside the chat: its desktop, as the picture the host reads from the guest, an open browser a
 * window on it. The person only watches: there is no takeover, and the panel says so instead of showing a control
 * that would do nothing.
 */
export function ComputerPanel({ dotId, computerState }: { dotId: string; computerState: string | null }) {
  if (!computerIsUp(computerState)) {
    return (
      <section aria-label="The Dot's computer" className="space-y-2 text-sm">
        <h2 className="font-medium">Computer</h2>
        <p className="text-muted-foreground">
          {computerState === null || computerState === "STOPPED"
            ? "The computer is stopped. Start it from the header to watch the Dot work."
            : `The computer is ${computerState.toLowerCase()}. The picture shows once it is running.`}
        </p>
      </section>
    );
  }

  return (
    <section aria-label="The Dot's computer" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
        <h2 className="text-sm font-medium">Computer</h2>
        <span className="text-xs text-muted-foreground">The Dot has control. You are watching.</span>
      </div>
      <FrameView dotId={dotId} />
    </section>
  );
}
