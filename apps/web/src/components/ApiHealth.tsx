"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";

const INTERVAL_MS = 30_000;

/** Whether the control plane answers through the proxy; checked every 30 seconds. */
export function ApiHealth() {
  const [state, setState] = useState<{ ok: boolean | null; detail: string }>({ ok: null, detail: "" });

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api
        .health()
        .then(() => !cancelled && setState({ ok: true, detail: "" }))
        .catch((error: unknown) => !cancelled && setState({ ok: false, detail: (error as Error).message }));
    };
    check();
    const timer = setInterval(check, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const label = state.ok === null ? "API: checking" : state.ok ? "API: ok" : "API: unreachable";
  return (
    <span
      className={`api-health ${state.ok === false ? "tone-error" : state.ok ? "tone-ok" : "tone-neutral"}`}
      role="status"
      title={state.detail || undefined}
    >
      {label}
    </span>
  );
}
