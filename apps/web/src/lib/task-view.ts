/** What the Tasks page shows of the Dot's tasks: which section each one belongs to, in what order, and how a task reads. */
import { TERMINAL_TASK_STATES, type TaskState } from "@invisible-dots/shared/browser";
import type { Tone } from "./timeline";
import type { Task } from "./types";

export type TaskSection = "running" | "scheduled" | "queue" | "history";

/** Running work: the agent is on it, or waits for an answer inside it. */
export function isRunning(status: TaskState): boolean {
  return status === "RUNNING" || status === "WAITING_APPROVAL";
}

export function isFinished(status: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(status);
}

/** A pending task whose time has not come is "Scheduled"; the others that wait are "Queue". */
export function sectionOf(task: Pick<Task, "status" | "scheduled_at">, now: number): TaskSection {
  if (isRunning(task.status)) return "running";
  if (isFinished(task.status)) return "history";
  return task.scheduled_at !== null && new Date(task.scheduled_at).getTime() > now ? "scheduled" : "queue";
}

export interface TaskSections {
  running: Task[];
  scheduled: Task[];
  /** In the order the dispatcher takes them: higher priority first, then the older. */
  queue: Task[];
  /** The newest finished first. */
  history: Task[];
}

function time(value: string | null): number {
  return value === null ? 0 : new Date(value).getTime();
}

export function groupTasks(tasks: readonly Task[], now: number): TaskSections {
  const sections: TaskSections = { running: [], scheduled: [], queue: [], history: [] };
  for (const task of tasks) sections[sectionOf(task, now)].push(task);
  sections.running.sort((a, b) => time(a.started_at ?? a.created_at) - time(b.started_at ?? b.created_at));
  sections.scheduled.sort((a, b) => time(a.scheduled_at) - time(b.scheduled_at) || b.priority - a.priority);
  sections.queue.sort((a, b) => b.priority - a.priority || time(a.created_at) - time(b.created_at));
  sections.history.sort((a, b) => time(b.finished_at ?? b.created_at) - time(a.finished_at ?? a.created_at));
  return sections;
}

export const HISTORY_FILTERS = ["all", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export function filterHistory(history: readonly Task[], filter: HistoryFilter): Task[] {
  return filter === "all" ? [...history] : history.filter((task) => task.status === filter);
}

/** How many finished tasks the history shows at first, and each time the person asks for more. */
export const HISTORY_PAGE = 20;

export const STATUS_LABEL: Record<TaskState, string> = {
  PENDING: "Queued",
  RUNNING: "Running",
  WAITING_APPROVAL: "Waiting for you",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export function statusLabel(status: string): string {
  return (STATUS_LABEL as Record<string, string>)[status] ?? status;
}

export const STATUS_TONE: Record<TaskState, Tone> = {
  PENDING: "neutral",
  RUNNING: "info",
  WAITING_APPROVAL: "warn",
  COMPLETED: "ok",
  FAILED: "error",
  CANCELLED: "neutral",
};

export function statusTone(status: string): Tone {
  return (STATUS_TONE as Record<string, Tone>)[status] ?? "neutral";
}

/** The names a person picks a priority by, and the integers the control plane stores for them (higher runs first). */
export const PRIORITIES = [
  { id: "low", label: "Low", value: -10 },
  { id: "normal", label: "Normal", value: 0 },
  { id: "high", label: "High", value: 10 },
  { id: "urgent", label: "Urgent", value: 100 },
] as const;

export const NORMAL_PRIORITY = 0;

/** The name of a stored priority; one that is none of the four (set through the API or the raw field) shows its number. */
export function priorityLabel(priority: number): string {
  return PRIORITIES.find((p) => p.value === priority)?.label ?? `Priority ${priority}`;
}

/** Seconds a task has worked: from its start to its end, or to `now` while it runs; null before it started. */
export function workedSeconds(task: Pick<Task, "started_at" | "finished_at">, now: number): number | null {
  if (task.started_at === null) return null;
  const end = task.finished_at === null ? now : new Date(task.finished_at).getTime();
  return Math.max(0, (end - new Date(task.started_at).getTime()) / 1000);
}
