import type { Tone } from "./timeline";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** Binary units, matching the config's sizes (1gb = 1024^3 bytes). */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "-";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const TONES: Record<string, Tone> = {
  // Dot states
  READY: "ok",
  CREATING: "info",
  WAITING_APPROVAL: "warn",
  DISABLED: "neutral",
  // VM states
  PROVISIONING: "info",
  STARTING: "info",
  STOPPING: "info",
  STOPPED: "neutral",
  DELETING: "warn",
  // Task states
  PENDING: "neutral",
  COMPLETED: "ok",
  FAILED: "error",
  CANCELLED: "neutral",
  // Shared by several
  RUNNING: "ok",
  IDLE: "neutral",
  ERROR: "error",
  // Approval statuses
  pending: "warn",
  approved: "ok",
  rejected: "error",
};

export function statusTone(status: string | null | undefined): Tone {
  return (status && TONES[status]) || "neutral";
}

/** Hide credentials in a proxy URL such as http://user:secret@host:8080. */
export function maskProxy(proxy: string | null | undefined): string {
  if (!proxy) return "";
  return proxy.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1***@");
}
