"use client";

import { FrameView } from "./frame-view";

/**
 * The Dot's desktop, as the picture the host reads from the guest every few seconds while the page is in view. The
 * person watches: there is no takeover, and the page says so rather than show a control that would do nothing.
 */
export function ScreenTab({ dotId }: { dotId: string }) {
  return (
    <section aria-labelledby="screen-heading" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="screen-heading" className="text-sm font-semibold">
          Desktop
        </h2>
        <p className="text-xs text-muted-foreground">The Dot has control. You are watching.</p>
      </div>
      <FrameView dotId={dotId} source={{ kind: "screen" }} />
    </section>
  );
}
