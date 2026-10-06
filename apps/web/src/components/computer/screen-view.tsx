// Derived from open-cowork packages/ui/src/components/ScreenView.tsx at fbbc671, MIT; changed: Tailwind classes of this app's tokens in place of the oc-* classes, the frame is an image URL (an object URL of the bytes the API returned) and not base64, the stale warning says how old the frame is, and the image's alt text names what is shown. No asset of open-cowork is used.

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface ScreenViewProps {
  /** An image URL of the current frame; none yet shows a placeholder. */
  src?: string | null;
  alt: string;
  /** Frames are arriving: shows the LIVE badge. */
  live?: boolean;
  /** Age in seconds after which the frame is flagged as old; needs `lastFrameAt`. */
  staleAfterSeconds?: number;
  /** ISO 8601 time the current frame was taken. */
  lastFrameAt?: string | null;
  /** The current time in ms; the caller renews it (useNow) so that the age keeps counting. */
  now?: number;
  /** What there is to say in place of a frame. */
  placeholder?: string;
  /** What the person can do with the picture, on the caption's line after the badge. */
  children?: ReactNode;
  className?: string;
}

/** How many seconds old a frame taken at `lastFrameAt` is at `now`, or null when it is not known. */
export function frameAgeSeconds(lastFrameAt: string | null | undefined, now: number): number | null {
  if (!lastFrameAt) return null;
  const at = Date.parse(lastFrameAt);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((now - at) / 1000));
}

/**
 * A remote screen drawn from periodic frames: a viewer box with the picture as large as the box allows, whole, and
 * under it a caption that says LIVE while frames arrive or how old the last one is, followed by the controls the caller
 * gives, so that they cost one line and not two. The box takes the height its
 * place gives it, or 16:9 of its width where the place has no height of its own (a phone's strip); the picture is laid
 * in it and never sizes it, so a tall frame cannot push the caption and the controls out of view.
 */
export function ScreenView({ src, alt, live = false, staleAfterSeconds, lastFrameAt, now = Date.now(), placeholder = "Waiting for the first frame...", children, className }: ScreenViewProps) {
  const age = frameAgeSeconds(lastFrameAt, now);
  const stale = staleAfterSeconds !== undefined && age !== null && age > staleAfterSeconds;
  return (
    <figure className={cn("flex min-h-0 flex-col gap-1.5", className)}>
      <div className="relative aspect-video min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted">
        {src ? (
          // A plain img: the source is an object URL of the image the API returned, which next/image cannot load.
          <img src={src} alt={alt} className="absolute inset-0 size-full object-contain" />
        ) : (
          <p className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-muted-foreground">{placeholder}</p>
        )}
      </div>
      {live || stale || children ? (
        <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {live && !stale ? <span className="rounded bg-ok-soft px-1.5 py-0.5 text-[0.6875rem] font-semibold tracking-wide text-ok">LIVE</span> : null}
          {stale ? (
            <span role="status" className="rounded bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn">
              This frame is {age}s old
            </span>
          ) : null}
          {children}
        </figcaption>
      ) : null}
    </figure>
  );
}
