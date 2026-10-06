/**
 * What the create form checks before a Dot is made: that the control plane answers, that its database does and that
 * an OpenRouter key is stored (`GET /api/health`), and then what the host needs for a Dot's computer to run, which is
 * the report of `invisible-dots doctor` (`GET /api/doctor`: QEMU, the accelerator, disk, the images). The list is the
 * one the panel draws, item by item.
 *
 * The doctor's own `openrouter` row is left out: the key is one fact and `GET /api/health` is the web's one reader
 * of it, so the panel would otherwise say it twice.
 */
import type { DoctorCheck, DoctorCheckId, HealthResponse } from "@invisible-dots/sdk";

export type PreflightState = "ok" | "failed" | "unknown";

export interface PreflightItem {
  id: "api" | "database" | "key" | "host" | Exclude<DoctorCheckId, "openrouter">;
  label: string;
  state: PreflightState;
  /** What was found, and for a failure what it means. */
  detail: string;
  /** The command or action that fixes a host check that is not ok. */
  fix?: string;
}

export type HealthResult = { health: HealthResponse } | { error: string };
export type HostResult = { checks: DoctorCheck[] } | { error: string };

export interface PreflightResult {
  health: HealthResult;
  host: HostResult;
}

const NOT_CHECKED_NO_ANSWER = "Not checked: the control plane does not answer.";

function controlPlaneItems(result: HealthResult): PreflightItem[] {
  if ("error" in result) {
    return [
      { id: "api", label: "Control plane", state: "failed", detail: result.error },
      { id: "database", label: "Database", state: "unknown", detail: NOT_CHECKED_NO_ANSWER },
      { id: "key", label: "OpenRouter key", state: "unknown", detail: NOT_CHECKED_NO_ANSWER },
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

function hostItems(health: HealthResult, host: HostResult): PreflightItem[] {
  if ("error" in health) return [{ id: "host", label: "This computer", state: "unknown", detail: NOT_CHECKED_NO_ANSWER }];
  if ("error" in host) return [{ id: "host", label: "This computer", state: "unknown", detail: `Not checked: ${host.error}` }];
  return host.checks
    .filter((check): check is DoctorCheck & { id: Exclude<DoctorCheckId, "openrouter"> } => check.id !== "openrouter")
    .map((check) => ({
      id: check.id,
      label: check.label,
      state: check.status === "ok" ? "ok" : "failed",
      detail: check.detail,
      ...(check.fix && check.status !== "ok" ? { fix: check.fix } : {}),
    }));
}

export function preflightItems({ health, host }: PreflightResult): PreflightItem[] {
  return [...controlPlaneItems(health), ...hostItems(health, host)];
}
