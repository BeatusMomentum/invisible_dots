// Derived from OpenDots (CopilotKit) src/client/TaskPresentation.tsx at 88f2a08, MIT; changed: `relativeTime` takes an ISO time, a number or a Date and the current time as a parameter, and says how far away a future time is.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function instant(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
}

/**
 * How long ago `value` was ("Just now", "5m ago", "3h ago", then the date), or how long until it ("in 5m", "in 3h",
 * "in 2d"). A value that is not a time comes back as it is.
 */
export function relativeTime(value: string | number | Date, now: number = Date.now()): string {
  const at = instant(value);
  if (Number.isNaN(at)) return String(value);
  const away = at - now;
  const span = Math.abs(away);
  if (span < MINUTE) return "Just now";
  if (away > 0) {
    if (span < HOUR) return `in ${Math.floor(span / MINUTE)}m`;
    if (span < DAY) return `in ${Math.floor(span / HOUR)}h`;
    return `in ${Math.floor(span / DAY)}d`;
  }
  if (span < HOUR) return `${Math.floor(span / MINUTE)}m ago`;
  if (span < DAY) return `${Math.floor(span / HOUR)}h ago`;
  return new Date(at).toLocaleDateString();
}
