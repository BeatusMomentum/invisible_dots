/**
 * Tasks that failed in the last 24 hours, which the Inbox puts under "Needs you" until the person has seen them and
 * says so. The host has no route for "failed tasks of every Dot", so each Dot's list (the newest tasks, which is where
 * a recent failure is) is read and the failed ones kept; a Dot whose list cannot be read is counted, not hidden.
 */
import type { InvisibleDotsClient } from "@invisible-dots/sdk";
import type { Dot, Task } from "./types";

/** How long a failure stays in the Inbox. */
export const FAILED_WINDOW_MS = 24 * 3_600_000;

export interface FailedTasks {
  /** Failed tasks, newest first, as of when they were read; `recentFailures` applies the window and the dismissals. */
  tasks: Task[];
  /** Dots whose tasks could not be read. */
  unread: number;
}

/** Whether a task failed less than a day before `now`. */
export function failedRecently(task: Pick<Task, "status" | "finished_at">, now: number): boolean {
  if (task.status !== "FAILED" || task.finished_at === null) return false;
  const finished = Date.parse(task.finished_at);
  return Number.isFinite(finished) && now - finished < FAILED_WINDOW_MS && finished <= now + 60_000;
}

function newestFirst(a: Task, b: Task): number {
  return Date.parse(b.finished_at ?? "") - Date.parse(a.finished_at ?? "");
}

export async function loadFailedTasks(client: Pick<InvisibleDotsClient, "listTasks">, dots: readonly Pick<Dot, "id">[], now = Date.now()): Promise<FailedTasks> {
  const answers = await Promise.allSettled(dots.map((dot) => client.listTasks(dot.id)));
  const tasks = answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : [])).filter((task) => failedRecently(task, now));
  return { tasks: tasks.sort(newestFirst), unread: answers.filter((answer) => answer.status === "rejected").length };
}

/** The failures the Inbox shows: within the window, and not dismissed. */
export function recentFailures(tasks: readonly Task[], dismissed: ReadonlySet<string>, now: number): Task[] {
  return tasks.filter((task) => !dismissed.has(task.id) && failedRecently(task, now));
}
