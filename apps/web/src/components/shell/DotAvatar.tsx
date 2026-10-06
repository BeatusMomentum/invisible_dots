import { avatarOf } from "../../lib/avatar";
import { RING_LABEL, type RingState } from "../../lib/attention";
import { cn } from "../../lib/utils";

const RING_CLASS: Record<RingState, string> = {
  stopped: "border-input",
  ready: "border-ok",
  working: "border-primary animate-breathe",
  waiting: "border-attention",
  error: "border-danger",
};

const SIZE_CLASS = {
  sm: { outer: "size-8", initial: "text-xs", badge: "size-2.5" },
  md: { outer: "size-10", initial: "text-sm", badge: "size-3" },
  lg: { outer: "size-12", initial: "text-base", badge: "size-3.5" },
} as const;

/**
 * A Dot's face: its gradient and first letter inside a ring that says what it is doing (grey stopped, green ready,
 * the accent breathing while it works, amber with a badge while it waits for the person, red on error). The ring is
 * also said in words, so color is never the only carrier.
 */
export function DotAvatar({ id, name, ring, size = "md", className }: { id: string; name: string; ring: RingState; size?: keyof typeof SIZE_CLASS; className?: string }) {
  const face = avatarOf(id, name);
  const sizes = SIZE_CLASS[size];
  return (
    <span role="img" aria-label={RING_LABEL[ring]} data-ring={ring} className={cn("relative inline-flex shrink-0 rounded-full border-2 p-0.5", sizes.outer, RING_CLASS[ring], className)}>
      <span aria-hidden="true" className={cn("flex size-full items-center justify-center rounded-full font-semibold text-white", sizes.initial)} style={{ background: face.background }}>
        {face.initial}
      </span>
      {ring === "waiting" ? <span aria-hidden="true" className={cn("absolute -top-0.5 -right-0.5 rounded-full border-2 border-card bg-attention", sizes.badge)} /> : null}
    </span>
  );
}
