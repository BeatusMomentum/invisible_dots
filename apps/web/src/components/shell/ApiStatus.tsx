"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";

const INTERVAL_MS = 30_000;

type Health = { state: "checking" } | { state: "ok"; version: string; keyConfigured: boolean } | { state: "down"; detail: string };

/** Whether the control plane answers through the proxy, with its version; checked every 30 seconds. */
export function ApiStatus() {
  const [health, setHealth] = useState<Health>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api
        .health()
        .then((answer) => !cancelled && setHealth({ state: "ok", version: answer.version, keyConfigured: answer.openrouter_configured }))
        .catch((error: unknown) => !cancelled && setHealth({ state: "down", detail: (error as Error).message }));
    };
    check();
    const timer = setInterval(check, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const label = health.state === "checking" ? "API: checking" : health.state === "ok" ? "API: ok" : "API: unreachable";
  return (
    <div className="space-y-0.5">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" title={health.state === "down" ? health.detail : undefined}>
        <span aria-hidden="true" className={cn("size-2 rounded-full", health.state === "ok" ? "bg-ok" : health.state === "down" ? "bg-danger" : "bg-muted-foreground")} />
        {label}
        {health.state === "ok" ? <span>v{health.version}</span> : null}
      </p>
      {health.state === "ok" && !health.keyConfigured ? <p className="text-xs text-warn">No OpenRouter key stored yet</p> : null}
    </div>
  );
}
