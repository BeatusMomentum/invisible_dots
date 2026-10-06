"use client";

import Link from "next/link";
import { cn } from "../../lib/utils";
import { useShell } from "./attention";

/** Whether the control plane answers through the proxy, with its version (the shell asks every 30 seconds); a missing key links to where it is entered. */
export function ApiStatus({ onNavigate }: { onNavigate?: () => void }) {
  const { health } = useShell();
  const state = health.error !== null ? "down" : health.data ? "ok" : "checking";

  const label = state === "checking" ? "API: checking" : state === "ok" ? "API: ok" : "API: unreachable";
  return (
    <div className="space-y-0.5">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" title={state === "down" ? String(health.error instanceof Error ? health.error.message : health.error) : undefined}>
        <span aria-hidden="true" className={cn("size-2 rounded-full", state === "ok" ? "bg-ok" : state === "down" ? "bg-danger" : "bg-muted-foreground")} />
        {label}
        {state === "ok" && health.data ? <span>v{health.data.version}</span> : null}
      </p>
      {state === "ok" && health.data && !health.data.openrouter_configured ? (
        <p className="text-xs text-warn">
          <Link href="/settings" onClick={onNavigate} className="underline underline-offset-2">
            No OpenRouter key stored yet
          </Link>
        </p>
      ) : null}
    </div>
  );
}
