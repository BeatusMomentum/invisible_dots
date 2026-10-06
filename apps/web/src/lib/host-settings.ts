/**
 * What the host settings page says that is not a check: the words after a key is saved, and the About rows from
 * the control plane's health answer.
 */
import type { HealthResponse } from "@invisible-dots/sdk";

/** What saving the OpenRouter key did: `pushed` is the number of running Dots whose computer was given it at once. */
export function keySavedMessage(pushed: number): string {
  if (pushed === 0) return "Saved. No Dot's computer is running, so each gets the key when it starts.";
  return `Saved. Pushed to ${pushed} running ${pushed === 1 ? "Dot" : "Dots"}.`;
}

export interface AboutRow {
  label: string;
  value: string;
  /** A path or a command: drawn in the monospace face. */
  code?: boolean;
}

const DATABASES: Record<HealthResponse["database_kind"], string> = {
  pglite: "Embedded PostgreSQL (PGlite), inside the server",
  pg: "External PostgreSQL (DATABASE_URL)",
};

/** The facts the About card lists, in its order. The per-Dot logs have no directory of their own: they are read with the CLI. */
export function aboutRows(health: HealthResponse): AboutRow[] {
  return [
    { label: "Version", value: health.version },
    { label: "Database", value: DATABASES[health.database_kind] },
    { label: "Data directory", value: health.data_dir, code: true },
    { label: "Logs directory", value: health.logs_dir, code: true },
    { label: "A Dot's logs", value: "invisible-dots logs <dot>", code: true },
  ];
}
