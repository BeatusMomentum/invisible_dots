// Derived from nanobot webui/src/components/thread/activity/ActivityStep.tsx at 9dc0aba, MIT; changed: no i18n and no tooltip primitive (the full text is the line's title), the label shimmers with a CSS class of this app, the marker colors are this app's tokens, and the label may wrap when the caller says so.

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export type ActivityStepTone = "neutral" | "active" | "success" | "error" | "warn";

const MARKER_TONE: Record<ActivityStepTone, string> = {
  neutral: "border-border text-muted-foreground",
  active: "border-primary/40 text-primary",
  success: "border-ok/40 text-ok",
  error: "border-danger/40 text-danger",
  warn: "border-warn/40 text-warn",
};

export interface ActivityStepProps {
  icon?: LucideIcon;
  /** The line. */
  label: ReactNode;
  /** The whole text of the line when it is cut short on screen. */
  title?: string;
  /** The step is going on now: its label shimmers. */
  active?: boolean;
  tone?: ActivityStepTone;
  className?: string;
}

/** One quiet line of what the Dot did: a small marker with the family's icon, then the words. */
export function ActivityStep({ icon: Icon, label, title, active = false, tone = active ? "active" : "neutral", className }: ActivityStepProps) {
  return (
    <div data-testid="activity-step" className={cn("grid min-w-0 grid-cols-[1.125rem_minmax(0,1fr)] items-start gap-2 py-0.5 text-ui", className)}>
      <span aria-hidden="true" className="flex h-5 w-[1.125rem] items-center justify-center">
        <span className={cn("grid size-3.5 place-items-center rounded-full border bg-background", MARKER_TONE[tone])}>{Icon ? <Icon className="size-2.5" strokeWidth={2.15} /> : null}</span>
      </span>
      <div title={title} className={cn("flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground", active && "shimmer")}>
        {label}
      </div>
    </div>
  );
}
