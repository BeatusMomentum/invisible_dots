// Derived from OpenDots (CopilotKit) src/client/TaskPresentation.tsx at 88f2a08, MIT; changed: the chip is a Tailwind pill over this app's task states and tones, and the priority chip is new.
import { cn } from "../../lib/utils";
import { priorityLabel, statusLabel, statusTone, NORMAL_PRIORITY } from "../../lib/task-view";
import { TONE_CLASS } from "../dot/tone";

const DOT_CLASS = { ok: "bg-ok", warn: "bg-warn", error: "bg-danger", info: "bg-info", neutral: "bg-muted-foreground" } as const;

/** A task's state as a pill: a dot in the tone's color and the state's word. A running task's dot breathes. */
export function TaskStatus({ status }: { status: string }) {
  const tone = statusTone(status);
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", TONE_CLASS[tone])}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT_CLASS[tone], status === "RUNNING" && "animate-pulse motion-reduce:animate-none")} />
      <span className="sr-only">Status: </span>
      {statusLabel(status)}
    </span>
  );
}

/** The priority, said only when it is not the ordinary one. */
export function PriorityChip({ priority }: { priority: number }) {
  if (priority === NORMAL_PRIORITY) return null;
  return (
    <span className="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
      <span className="sr-only">Priority: </span>
      {priorityLabel(priority)}
    </span>
  );
}
