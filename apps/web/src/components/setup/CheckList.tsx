"use client";

import { CircleCheckIcon, CircleHelpIcon, CircleXIcon, RefreshCwIcon } from "lucide-react";
import type { PreflightItem, PreflightState } from "../../lib/preflight";
import { cn } from "../../lib/utils";
import { CopyButton } from "../copy-button";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

const STATE = {
  ok: { Icon: CircleCheckIcon, className: "text-ok", word: "Ready" },
  failed: { Icon: CircleXIcon, className: "text-danger", word: "Needs attention" },
  unknown: { Icon: CircleHelpIcon, className: "text-muted-foreground", word: "Not checked" },
} satisfies Record<PreflightState, { Icon: typeof CircleCheckIcon; className: string; word: string }>;

/** The checks, one line each: what was found, and for one that is not ready the command that fixes it, with a button that copies it. */
export function CheckList({ items }: { items: readonly PreflightItem[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => {
        const { Icon, className, word } = STATE[item.state];
        return (
          <li key={item.id} className="flex gap-2.5 text-sm">
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", className)} />
            <div className="min-w-0">
              <p className="font-medium">
                {item.label}
                <span className="sr-only">: {word}</span>
              </p>
              <p className="text-xs text-muted-foreground">{item.detail}</p>
              {item.fix ? (
                <p className="text-xs">
                  Fix: <code className="rounded bg-muted px-1 py-0.5 font-mono break-all">{item.fix}</code>
                  <CopyButton text={item.fix} label={`Copy the fix for ${item.label}`} className="ml-1.5 align-middle" />
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Placeholders while the first answers are on their way. */
export function CheckListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

/** "Check again": the host may have been fixed since. It spins while the checks run. */
export function CheckAgainButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Check again" onClick={onClick} disabled={loading}>
      <RefreshCwIcon className={cn(loading && "animate-spin motion-reduce:animate-none")} />
    </Button>
  );
}
