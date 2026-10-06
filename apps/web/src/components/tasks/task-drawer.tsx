"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDate, formatDuration, formatUsd } from "../../lib/format";
import { storyOf } from "../../lib/task-events";
import { isFinished, priorityLabel, workedSeconds } from "../../lib/task-view";
import { api, ApiError } from "../../lib/api";
import { useNow } from "../../lib/use-now";
import { TaskApprovals } from "../approvals/TaskApprovals";
import { ErrorAlert } from "../ErrorAlert";
import { useDot } from "../DotShell";
import { useLiveRefresh } from "../events";
import { Markdown } from "../markdown";
import { useResource } from "../ui";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { CancelTaskButton } from "./cancel-task";
import { Story } from "./story";
import { TaskStatus } from "./task-status";
import { useTaskStory, useTasks } from "./tasks-data";

const TASK_EVENTS = ["task.started", "task.progress", "task.completed", "task.failed", "task.cancelled", "approval.requested", "approval.resolved"];

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

/**
 * One task, opened over the list at its own address: its state and numbers, its result or the reason it failed, and
 * its story from the Dot's event log. Closing it goes back to the list. The route that serves a task knows it by its id
 * alone, so a task of another Dot is as good as missing here: this address is one Dot's.
 */
export function TaskDrawer({ taskId }: { taskId: string }) {
  const { dotId, tasks } = useTasks();
  const router = useRouter();
  const task = useResource(() => api.getTask(taskId), `task:${taskId}`);
  useLiveRefresh(task.reload, TASK_EVENTS);
  const { dot } = useDot();
  // Shown only once the Dot's own id is known, and only if the task is that Dot's.
  const foreign = task.data !== undefined && dot.data !== undefined && task.data.dot_id !== dot.data.id;
  const record = dot.data !== undefined && !foreign ? task.data : undefined;
  const now = useNow(1000, record !== undefined && !isFinished(record.status));
  const close = () => router.push(`/dots/${encodeURIComponent(dotId)}/tasks`);
  const history = useTaskStory(dotId, taskId, record !== undefined);
  const missing = foreign || (task.error instanceof ApiError && task.error.status === 404);

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : close())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" aria-describedby="task-drawer-summary">
        <SheetHeader>
          <SheetTitle className="pr-6 break-words">{record ? record.description : "Task"}</SheetTitle>
          <SheetDescription id="task-drawer-summary">{record ? `Created ${formatDate(record.created_at)}` : "The task's state, result and story."}</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          {missing ? (
            <Alert variant="destructive">
              <AlertTitle>This task does not exist</AlertTitle>
              <AlertDescription>
                <p>It may belong to another Dot or have been removed.</p>
                <Button asChild variant="outline" size="xs">
                  <Link href={`/dots/${encodeURIComponent(dotId)}/tasks`}>Back to the tasks</Link>
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <ErrorAlert error={task.error ?? dot.error} title="Could not load the task" />
          )}
          {record === undefined && !missing && !task.error && !dot.error ? <Skeleton className="h-20 w-full" /> : null}

          {record ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <TaskStatus status={record.status} />
                {!isFinished(record.status) ? (
                  <CancelTaskButton
                    task={record}
                    onDone={() => {
                      task.reload();
                      tasks.reload();
                    }}
                  />
                ) : null}
              </div>

              <TaskApprovals taskId={record.id} />

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                <Fact label="Priority">{priorityLabel(record.priority)}</Fact>
                <Fact label="Spent">{formatUsd(record.spent_usd)}</Fact>
                <Fact label={isFinished(record.status) ? "Took" : "Running for"}>
                  {workedSeconds(record, now) === null ? "-" : formatDuration(workedSeconds(record, now))}
                </Fact>
                {record.scheduled_at ? <Fact label="Not before">{formatDate(record.scheduled_at)}</Fact> : null}
                <Fact label="Started">{formatDate(record.started_at)}</Fact>
                <Fact label="Finished">{formatDate(record.finished_at)}</Fact>
              </dl>

              {record.error !== null ? (
                <Alert variant="destructive">
                  <AlertTitle>{record.status === "CANCELLED" ? "Cancelled" : "Failed"}</AlertTitle>
                  <AlertDescription>
                    <p className="whitespace-pre-wrap">{record.error}</p>
                  </AlertDescription>
                </Alert>
              ) : null}
              {record.summary ? (
                <section aria-labelledby="task-result" className="space-y-2">
                  <h3 id="task-result" className="text-sm font-semibold">
                    Result
                  </h3>
                  <Markdown>{record.summary}</Markdown>
                </section>
              ) : null}

              <section aria-labelledby="task-story" className="space-y-3">
                <h3 id="task-story" className="text-sm font-semibold">
                  What happened
                </h3>
                {history.status === "failed" ? (
                  <Alert variant="destructive">
                    <AlertTitle>Could not read the task&apos;s history</AlertTitle>
                    <AlertDescription>
                      <p>{history.error instanceof Error ? history.error.message : String(history.error)}</p>
                      <Button type="button" variant="outline" size="xs" onClick={history.retry}>
                        Try again
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : history.status === "loaded" ? (
                  <Story steps={storyOf(history.events, record.id)} />
                ) : (
                  <Skeleton className="h-16 w-full" aria-busy="true" />
                )}
              </section>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
