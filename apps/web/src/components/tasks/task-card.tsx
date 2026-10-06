"use client";

import Link from "next/link";
import { formatDate, formatDuration, formatUsd } from "../../lib/format";
import { progressOf } from "../../lib/task-events";
import { workedSeconds } from "../../lib/task-view";
import { relativeTime } from "../../lib/time";
import type { Task } from "../../lib/types";
import { useNow } from "../../lib/use-now";
import { TaskApprovals } from "../approvals/TaskApprovals";
import { CancelTaskButton } from "./cancel-task";
import { PriorityChip, TaskStatus } from "./task-status";
import { useTasks } from "./tasks-data";

export function taskHref(dotId: string, taskId: string): string {
  return `/dots/${encodeURIComponent(dotId)}/tasks/${encodeURIComponent(taskId)}`;
}

/** The task's own words, linked to its drawer. */
function Title({ task, dotId }: { task: Task; dotId: string }) {
  return (
    <h3 className="line-clamp-2 min-w-0 flex-1 text-sm font-medium break-words">
      <Link href={taskHref(dotId, task.id)} scroll={false} className="hover:underline">
        {task.description}
      </Link>
    </h3>
  );
}

/** Time since the task started, counting while it runs. */
export function Elapsed({ task }: { task: Pick<Task, "started_at" | "finished_at"> }) {
  const running = task.finished_at === null;
  const now = useNow(1000, running);
  const seconds = workedSeconds(task, now);
  return <>{seconds === null ? "-" : formatDuration(seconds)}</>;
}

/**
 * A task the Dot is working on (or waits for an answer in): the newest line it reported, what it has spent, how long
 * it has run, and the ways to act on it.
 */
export function RunningCard({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const { dotId, history } = useTasks();
  const progress = progressOf(history.events, task.id);
  const waiting = task.status === "WAITING_APPROVAL";

  return (
    <article aria-label={task.description} className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-start gap-2">
        <Title task={task} dotId={dotId} />
        <TaskStatus status={task.status} />
        <PriorityChip priority={task.priority} />
      </div>

      <p aria-live="polite" className="space-y-1 text-sm text-muted-foreground">
        {progress ? (
          <>
            <span className="sr-only">Latest progress: </span>
            <span className="line-clamp-3 whitespace-pre-wrap">{progress.text}</span>{" "}
            <time dateTime={progress.at} title={formatDate(progress.at)} className="text-xs">
              {relativeTime(progress.at)}
            </time>
          </>
        ) : history.status === "failed" ? (
          "What the task reported could not be read."
        ) : history.status === "loaded" ? (
          "Working on it. It has not reported anything yet."
        ) : (
          "Reading what the task reported..."
        )}
      </p>

      <TaskApprovals taskId={task.id} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span>
          Spent <span className="font-medium text-foreground">{formatUsd(task.spent_usd)}</span>
        </span>
        <span>
          Running for{" "}
          <span className="font-medium text-foreground">
            <Elapsed task={task} />
          </span>
        </span>
        {waiting ? <span className="rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn">Waiting for you</span> : null}
        <span className="ml-auto">
          <CancelTaskButton task={task} onDone={onChanged} />
        </span>
      </div>
    </article>
  );
}

/** A task that has not started: where it stands in the queue, or when it becomes due. */
export function QueuedCard({ task, position, onChanged, now }: { task: Task; position: number | null; onChanged: () => void; now: number }) {
  const { dotId } = useTasks();
  const due = task.scheduled_at !== null && new Date(task.scheduled_at).getTime() > now ? task.scheduled_at : null;
  return (
    <article aria-label={task.description} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card p-3 text-card-foreground">
      {position !== null ? <span className="w-12 shrink-0 text-xs font-medium text-muted-foreground">{position === 1 ? "Next" : `#${position}`}</span> : null}
      <Title task={task} dotId={dotId} />
      <PriorityChip priority={task.priority} />
      <span className="text-xs text-muted-foreground">
        {due !== null ? (
          <>
            Starts <time dateTime={due}>{formatDate(due)}</time> ({relativeTime(due, now)})
          </>
        ) : (
          <>
            Created{" "}
            <time dateTime={task.created_at} title={formatDate(task.created_at)}>
              {relativeTime(task.created_at, now)}
            </time>
          </>
        )}
      </span>
      <CancelTaskButton task={task} onDone={onChanged} />
    </article>
  );
}
