// Derived from assistant-ui packages/ui/src/components/react/assistant-ui/elements/schedule-card.tsx at 0bdf050, MIT; changed: this app's tokens and shadcn Switch instead of surfaces.tsx and the hand-made switch; the history list is one "last run" (the engine reports the last run of an automation, not a history) with three outcomes (ran, failed, skipped) and the error it ended with; the Next row says "Paused" and dims as before, and the card is an article named for the automation, with the Dot's message and a slot for actions, which are new.
"use client";

import { CheckIcon, ClockIcon, MinusIcon, XIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import type { AutomationRunStatus } from "@invisible-dots/shared/browser";
import { cn } from "../../lib/utils";
import { Switch } from "../ui/switch";

export interface ScheduleLastRun {
  /** When it ran, already in words. */
  at: string;
  status: AutomationRunStatus;
  /** What it ended with, for a run that failed. */
  error?: string | null;
}

const RUN_WORD: Record<AutomationRunStatus, string> = { ok: "ran", error: "failed", skipped: "skipped" };
const RUN_ICON = { ok: CheckIcon, error: XIcon, skipped: MinusIcon } as const;
const RUN_TONE: Record<AutomationRunStatus, string> = { ok: "text-ok", error: "text-danger", skipped: "text-muted-foreground" };

/**
 * A run that repeats on its own: its name and cadence, whether it is switched on, when it runs next, and how its last
 * run went. A display with a switch: the switch only reports the click (`onToggle`) and `enabled` keeps driving it,
 * so whoever owns the request flips it once the request has succeeded.
 */
export function ScheduleCard({
  name,
  cadence,
  nextRun,
  enabled,
  lastRun,
  message,
  onToggle,
  toggleDisabled = false,
  actions,
  className,
  ...props
}: {
  name: string;
  /** The schedule in words. */
  cadence: string;
  /** What the Next run row says; a paused card shows "Paused" there whatever it is given. */
  nextRun: string;
  enabled: boolean;
  /** Null when it has not run yet. */
  lastRun: ScheduleLastRun | null;
  /** What the Dot is told when it runs. */
  message?: string;
  onToggle?: () => void;
  toggleDisabled?: boolean;
  actions?: ReactNode;
} & Omit<ComponentProps<"article">, "children" | "onToggle">) {
  const Icon = lastRun ? RUN_ICON[lastRun.status] : null;
  return (
    <article aria-label={name} data-slot="schedule-card" className={cn("space-y-3 rounded-xl border bg-card p-4 text-card-foreground", className)} {...props}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ClockIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium" title={name}>
            {name}
          </h3>
          <p className="text-xs text-muted-foreground">{cadence}</p>
        </div>
        <Switch checked={enabled} disabled={toggleDisabled} onCheckedChange={() => onToggle?.()} aria-label={`${name} is switched on`} />
      </div>

      <dl className="space-y-1.5 text-sm">
        <div className={cn("flex flex-wrap gap-x-2", !enabled && "opacity-70")}>
          <dt className="w-20 shrink-0 text-muted-foreground">Next run</dt>
          <dd className="min-w-0 flex-1">{enabled ? nextRun : "Paused"}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Last run</dt>
          <dd className="min-w-0 flex-1">
            {lastRun === null || Icon === null ? (
              <span className="text-muted-foreground">Has not run yet</span>
            ) : (
              <>
                <span className={cn("inline-flex items-center gap-1 font-medium", RUN_TONE[lastRun.status])}>
                  <Icon aria-hidden="true" className="size-3.5" />
                  {RUN_WORD[lastRun.status][0]!.toUpperCase() + RUN_WORD[lastRun.status].slice(1)}
                </span>{" "}
                <span className="text-muted-foreground">{lastRun.at}</span>
                {lastRun.error ? <p className="mt-0.5 text-xs break-words text-danger">{lastRun.error}</p> : null}
              </>
            )}
          </dd>
        </div>
      </dl>

      {message ? (
        <p className="line-clamp-3 rounded-md bg-muted px-3 py-2 text-xs break-words whitespace-pre-wrap text-muted-foreground" title={message}>
          <span className="sr-only">The Dot is told: </span>
          {message}
        </p>
      ) : null}

      {actions ? <div className="flex flex-wrap justify-end gap-2">{actions}</div> : null}
    </article>
  );
}
