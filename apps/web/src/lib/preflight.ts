/**
 * What the create form checks before a Dot is made, from what the control plane's `GET /api/health` says today:
 * that it answers, that its database does, and that an OpenRouter key is stored. The list is the one the panel
 * draws, item by item, so a check the control plane learns to report later is one more item here and nothing else.
 */
import type { HealthResponse } from "@invisible-dots/sdk";

export type PreflightState = "ok" | "failed" | "unknown";

export interface PreflightItem {
  id: "api" | "database" | "key";
  label: string;
  state: PreflightState;
  /** What was found, and for a failure what it means. */
  detail: string;
}

export type HealthResult = { health: HealthResponse } | { error: string };

export function preflightItems(result: HealthResult): PreflightItem[] {
  if ("error" in result) {
    return [
      { id: "api", label: "Control plane", state: "failed", detail: result.error },
      { id: "database", label: "Database", state: "unknown", detail: "Not checked: the control plane does not answer." },
      { id: "key", label: "OpenRouter key", state: "unknown", detail: "Not checked: the control plane does not answer." },
    ];
  }
  const { health } = result;
  return [
    { id: "api", label: "Control plane", state: "ok", detail: `Answering, version ${health.version}.` },
    {
      id: "database",
      label: "Database",
      state: health.database === "ok" ? "ok" : "failed",
      detail: health.database === "ok" ? "Answering." : "The control plane cannot use its database.",
    },
    {
      id: "key",
      label: "OpenRouter key",
      state: health.openrouter_configured ? "ok" : "failed",
      detail: health.openrouter_configured ? "Stored." : "None stored. The Dot's computer cannot answer until one is.",
    },
  ];
}
