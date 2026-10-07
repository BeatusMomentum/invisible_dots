"use client";

import Link from "next/link";
import { useState } from "react";
import { formatDate, formatDuration, formatUsd } from "../../lib/format";
import { filterHistory, HISTORY_FILTERS, HISTORY_PAGE, statusLabel, workedSeconds, type HistoryFilter } from "../../lib/task-view";
import { relativeTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import type { Task } from "../../lib/types";
import { Button } from "../ui/button";
import { taskHref } from "./task-card";
import { PriorityChip, TaskStatus } from "./task-status";

const FILTER_LABEL: Record<HistoryFilter, string> = {
  all: "All",
  COMPLETED: statusLabel("COMPLETED"),
  FAILED: statusLabel("FAILED"),
  CANCELLED: statusLabel("CANCELLED"),
};

/** One line of what the task left behind: its error as the Dot reported it, or its summary. */
function Outcome({ task }: { task: Task }) {
  const text = task.error ?? task.summary ?? "";
  if (text === "") return <span className="text-muted-foreground">-</span>;
  return <span className={cn("line-clamp-2 break-words", task.error !== null && "text-danger")}>{text}</span>;
}

/** Finished tasks, newest first: filtered by how they ended and shown a page at a time. */
export function HistoryTable({ dotId, history, now }: { dotId: string; history: readonly Task[]; now: number }) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [shown, setShown] = useState(HISTORY_PAGE);
  const filtered = filterHistory(history, filter);
  const visible = filtered.slice(0, shown);

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Show tasks that" className="flex flex-wrap gap-1.5">
        {HISTORY_FILTERS.map((id) => (
          <Button
            key={id}
            type="button"
            size="xs"
            variant={filter === id ? "default" : "outline"}
            aria-pressed={filter === id}
            onClick={() => {
              setFilter(id);
              setShown(HISTORY_PAGE);
            }}
          >
            {FILTER_LABEL[id]}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {filter === "all" ? "finished" : statusLabel(filter).toLowerCase()} tasks.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Task
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Finished
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Took
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Spent
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Result
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((task) => {
                const worked = workedSeconds(task, now);
                return (
                  <tr key={task.id} className="align-top">
                    <td className="max-w-64 space-y-1 px-3 py-2">
                      <Link href={taskHref(dotId, task.id)} scroll={false} className="line-clamp-2 font-medium break-words hover:underline">
                        {task.description}
                      </Link>
                      <PriorityChip priority={task.priority} />
                    </td>
                    <td className="px-3 py-2">
                      <TaskStatus status={task.status} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {task.finished_at ? (
                        <time dateTime={task.finished_at} title={formatDate(task.finished_at)}>
                          {relativeTime(task.finished_at, now)}
                        </time>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{worked === null ? "-" : formatDuration(worked)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatUsd(task.spent_usd)}</td>
                    <td className="max-w-80 px-3 py-2">
                      <Outcome task={task} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > visible.length ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setShown(shown + HISTORY_PAGE)}>
          Show {Math.min(HISTORY_PAGE, filtered.length - visible.length)} more
        </Button>
      ) : null}
    </div>
  );
}
