"use client";

import { TASK_LIST_LIMIT } from "@invisible-dots/shared/browser";
import { useMemo, type ReactNode } from "react";
import { groupTasks } from "../../lib/task-view";
import { useNow } from "../../lib/use-now";
import { useDot } from "../DotShell";
import { ErrorAlert } from "../ErrorAlert";
import { Skeleton } from "../ui/skeleton";
import { HistoryTable } from "./history-table";
import { NewTaskDialog } from "./new-task-dialog";
import { QueuedCard, RunningCard } from "./task-card";
import { TasksProvider, useTasks } from "./tasks-data";

/**
 * The Tasks page (S8): what the Dot is working on, what waits, and what it has done. `children` is the page of the
 * task the address names, if it names one: the drawer, which opens over this list without reloading it.
 */
export function TasksView({ children }: { children: ReactNode }) {
  const { dotId } = useDot();
  return (
    <TasksProvider key={dotId} dotId={dotId}>
      <Sections />
      {children}
    </TasksProvider>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const id = `tasks-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-sm font-semibold">
        {title}
        {count !== undefined ? <span className="ml-1.5 font-normal text-muted-foreground">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Sections() {
  const { dotId, tasks } = useTasks();
  // Whether a scheduled task is due yet is read against this clock; a minute's accuracy is the page's promise.
  const now = useNow(15_000);
  const sections = useMemo(() => groupTasks(tasks.data ?? [], now), [tasks.data, now]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Work you give the Dot. It takes one task at a time, the more urgent first.</p>
        <NewTaskDialog dotId={dotId} onCreated={tasks.reload} />
      </div>

      <ErrorAlert error={tasks.error} title="Could not load the tasks" />
      {tasks.data === undefined && !tasks.error ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : null}

      {tasks.data !== undefined && tasks.data.length >= TASK_LIST_LIMIT ? (
        <p role="status" className="rounded-lg border bg-muted px-3 py-2 text-sm">
          The newest {TASK_LIST_LIMIT} tasks are listed. If the Dot has more, the older ones are not shown here, and the queue
          below leaves out any of them that still wait.
        </p>
      ) : null}

      {tasks.data !== undefined && tasks.data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="font-medium">No tasks yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Use New task to give the Dot something to do. You can watch it work here.</p>
        </div>
      ) : null}

      {tasks.data !== undefined && tasks.data.length > 0 ? (
        <>
          <Section title="Running" count={sections.running.length}>
            {sections.running.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is running.</p>
            ) : (
              <ul className="space-y-3">
                {sections.running.map((task) => (
                  <li key={task.id}>
                    <RunningCard task={task} onChanged={tasks.reload} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {sections.scheduled.length > 0 ? (
            <Section title="Scheduled" count={sections.scheduled.length}>
              <ul className="space-y-2">
                {sections.scheduled.map((task) => (
                  <li key={task.id}>
                    <QueuedCard task={task} position={null} now={now} onChanged={tasks.reload} />
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {sections.queue.length > 0 ? (
            <Section title="Queue" count={sections.queue.length}>
              <ol className="space-y-2">
                {sections.queue.map((task, index) => (
                  <li key={task.id}>
                    <QueuedCard task={task} position={index + 1} now={now} onChanged={tasks.reload} />
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          <Section title="History" count={sections.history.length}>
            {sections.history.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has finished yet.</p> : <HistoryTable dotId={dotId} history={sections.history} now={now} />}
          </Section>
        </>
      ) : null}
    </div>
  );
}
