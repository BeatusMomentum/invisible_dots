"use client";

import { CircleCheckIcon, CircleHelpIcon, CircleXIcon, RefreshCwIcon } from "lucide-react";
import { api } from "../../lib/api";
import { preflightItems, type HealthResult, type PreflightState } from "../../lib/preflight";
import { cn } from "../../lib/utils";
import { useResource } from "../ui";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

const STATE = {
  ok: { Icon: CircleCheckIcon, className: "text-ok", word: "Ready" },
  failed: { Icon: CircleXIcon, className: "text-danger", word: "Needs attention" },
  unknown: { Icon: CircleHelpIcon, className: "text-muted-foreground", word: "Not checked" },
} satisfies Record<PreflightState, { Icon: typeof CircleCheckIcon; className: string; word: string }>;

async function check(): Promise<HealthResult> {
  try {
    return { health: await api.health() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** What a new Dot depends on, checked when the page opens and again on request. It informs; creating stays possible. */
export function PreflightPanel() {
  const result = useResource(check, "preflight");
  const items = result.data ? preflightItems(result.data) : null;
  return (
    <section aria-labelledby="preflight-title" className="space-y-3 rounded-lg border bg-card p-4" aria-busy={result.loading}>
      <div className="flex items-center justify-between gap-2">
        <h2 id="preflight-title" className="text-sm font-semibold">
          Before you create
        </h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Check again" onClick={result.reload} disabled={result.loading}>
          <RefreshCwIcon className={cn(result.loading && "animate-spin motion-reduce:animate-none")} />
        </Button>
      </div>
      {items === null ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
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
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
