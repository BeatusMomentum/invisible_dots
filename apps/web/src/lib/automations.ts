/**
 * What the Automations view says of an automation: when it runs, in words; when it runs next; what its last run
 * did. The engine's cron service owns the schedule (`at`, `every`, or a cron expression read in a time zone) and
 * these functions only read what it reports, so a schedule this file cannot put in plain words is shown as the
 * expression it is, never guessed at.
 */
import { resolvePermission, type Automation, type AutomationRunStatus, type AutomationSchedule, type DotConfig } from "@invisible-dots/shared/browser";
import { relativeTime } from "./time";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function every(count: number, unit: string): string {
  return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
}

/** An interval in words: "every 30 minutes", "every day". */
export function describeEvery(ms: number): string {
  if (ms % DAY === 0) return every(ms / DAY, "day");
  if (ms % HOUR === 0) return every(ms / HOUR, "hour");
  if (ms % MINUTE === 0) return every(ms / MINUTE, "minute");
  return every(Math.max(1, Math.round(ms / SECOND)), "second");
}

/** A moment as a person reads a calendar: "Mar 10, 2026, 9:00 AM", in the browser's zone. */
export function whenLabel(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** The numbers a cron field names, for a field made of numbers, ranges and commas; null for anything else (steps, names, `*`). */
function numbers(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > to || from < min || to > max) return null;
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The days of the week of a cron field made of numbers ("1-5", "0,6"), as words; null for a field of any other kind. */
function describeDays(field: string): string | null {
  // 7 is Sunday as well as 0.
  const raw = numbers(field, 0, 7);
  if (raw === null) return null;
  const days = [...new Set(raw.map((day) => day % 7))].sort((a, b) => a - b);
  if (days.length === 7) return "every day";
  if (days.length === 5 && days.join() === "1,2,3,4,5") return "every weekday";
  if (days.length === 2 && days.join() === "0,6") return "every weekend day";
  return `every ${list(days.map((day) => WEEKDAYS[day]!))}`;
}

/** A five-field cron expression in words, or null when it is not one of the shapes people write. */
function describeCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (month !== "*") return null;

  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (minute === "*" && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") return "every minute";
  if (everyMinutes && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    const n = Number(everyMinutes[1]);
    return n === 1 ? "every minute" : n > 1 && n < 60 ? `every ${n} minutes` : null;
  }
  const atMinute = numbers(minute, 0, 59);
  if (atMinute === null || atMinute.length !== 1) return null;
  const m = atMinute[0]!;
  if (dayOfMonth === "*" && dayOfWeek === "*") {
    if (hour === "*") return m === 0 ? "every hour, on the hour" : `every hour at minute ${m}`;
    const everyHours = /^\*\/(\d+)$/.exec(hour);
    if (everyHours) {
      const n = Number(everyHours[1]);
      if (n < 2 || n > 23) return null;
      return m === 0 ? `every ${n} hours` : `every ${n} hours at minute ${m}`;
    }
  }
  const atHour = numbers(hour, 0, 23);
  if (atHour === null || atHour.length !== 1) return null;
  const time = `${two(atHour[0]!)}:${two(m)}`;
  if (dayOfMonth === "*") {
    const days = dayOfWeek === "*" ? "every day" : describeDays(dayOfWeek);
    return days === null ? null : `${days} at ${time}`;
  }
  if (dayOfWeek !== "*") return null;
  const onDays = numbers(dayOfMonth, 1, 31);
  if (onDays === null) return null;
  return `on day ${list(onDays.map(String))} of every month at ${time}`;
}

/**
 * When an automation runs, in words ("every weekday at 09:00 (Europe/Rome)", "every 30 minutes", "once, Mar 10, 2026,
 * 9:00 AM"). A cron expression is read in its own time zone, which is said, so a schedule never reads as the
 * person's own clock when it is not.
 */
export function describeSchedule(schedule: AutomationSchedule, locale?: string): string {
  switch (schedule.kind) {
    case "at":
      return schedule.at_ms === undefined ? "once" : `once, ${whenLabel(schedule.at_ms, locale)}`;
    case "every":
      return schedule.every_ms === undefined ? "on an interval" : describeEvery(schedule.every_ms);
    case "cron": {
      const expression = schedule.expr ?? "";
      const zone = schedule.tz ? schedule.tz : "the computer's time zone";
      const words = describeCron(expression);
      return words === null ? `cron "${expression}" (${zone})` : `${words} (${zone})`;
    }
  }
}

/** What the Next run row says: the moment and how far away it is, "Paused" for a paused automation, or that no run is left. */
export function nextRunLabel(automation: Pick<Automation, "enabled" | "next_run_at_ms">, now: number, locale?: string): string {
  if (!automation.enabled) return "Paused";
  if (automation.next_run_at_ms === null) return "No run left";
  return `${whenLabel(automation.next_run_at_ms, locale)} (${relativeTime(automation.next_run_at_ms, now)})`;
}

export interface LastRun {
  /** The moment and how long ago it was. */
  at: string;
  status: AutomationRunStatus;
  /** What went wrong, for a run that ended in error. */
  error: string | null;
}

/** The automation's last run, or null when it has not run yet. */
export function lastRunOf(automation: Pick<Automation, "last_run_at_ms" | "last_status" | "last_error">, now: number, locale?: string): LastRun | null {
  if (automation.last_run_at_ms === null) return null;
  return {
    at: `${whenLabel(automation.last_run_at_ms, locale)} (${relativeTime(automation.last_run_at_ms, now)})`,
    // The engine reports a status with every run; a run without one is shown as it ran, not as a failure.
    status: automation.last_status ?? "ok",
    error: automation.last_error,
  };
}

/** The automations in the order a person looks for them: the ones that will run, soonest first, then the spent, then the paused. */
export function sortAutomations(automations: readonly Automation[]): Automation[] {
  const rank = (a: Automation) => (a.enabled && a.next_run_at_ms !== null ? 0 : a.enabled ? 1 : 2);
  return [...automations].sort(
    (a, b) => rank(a) - rank(b) || (a.next_run_at_ms ?? 0) - (b.next_run_at_ms ?? 0) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id),
  );
}

/** What the empty list says about how an automation comes to exist: it depends on what the Dot's config does with the permission. */
export function emptyAutomationsText(config: Pick<DotConfig, "permissions"> | undefined): string {
  const decision = config === undefined ? "ask" : resolvePermission(config, "automations");
  switch (decision) {
    case "ask":
      return "The Dot has no automations. When it wants to set one up, it asks you first (the automations permission asks by default); once you allow it, the automation shows here.";
    case "allow":
      return "The Dot has no automations. It may set them up on its own (the automations permission is allow), and they show here.";
    case "deny":
      return "The Dot has no automations, and cannot set any up: the automations permission is deny. Allow it in the Dot's settings to let it schedule work.";
  }
}
