/**
 * What a task did, read from the Dot's event log: the newest line it reported, and its story step by step for the
 * drawer. The log is the one record of both (the task row keeps only its state, result and spend). Both are read by
 * the task (`task_id`, indexed in the database), so what it costs does not grow with the age of the Dot.
 */
import type { InvisibleDotsClient } from "@invisible-dots/sdk";
import { mergeEvents, readEventLog, readRecentEvents } from "./event-log";
import type { StoredEvent } from "./types";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function taskIdOf(event: Pick<StoredEvent, "data">): string {
  return text(event.data?.task_id);
}

/** The event types that can belong to a task's story; the control plane keeps only these when the log is read. */
export const TASK_EVENT_TYPES: readonly string[] = [
  "task.created",
  "task.started",
  "task.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "tool.called",
  "approval.requested",
  "approval.resolved",
];

/** Whether an event belongs to a task's story: it names the task (an approval's answer does too, see `approval.resolved`). */
export function isTaskEvent(event: Pick<StoredEvent, "data">): boolean {
  return taskIdOf(event) !== "";
}

/** Every event of one task's story, oldest first; a tool call or an approval of the chat names no task and is not among them. */
export function readTaskStory(client: Pick<InvisibleDotsClient, "events">, dotId: string, taskId: string): Promise<StoredEvent[]> {
  return readEventLog(client, dotId, { types: TASK_EVENT_TYPES, taskId });
}

export function mergeTaskEvents(current: readonly StoredEvent[], incoming: readonly StoredEvent[]): StoredEvent[] {
  return mergeEvents(current, incoming.filter(isTaskEvent));
}

export interface TaskProgress {
  /** The id of the event it was reported in: a later one is newer, however it came. */
  id: number;
  text: string;
  at: string;
}

export function progressOfEvent(event: Pick<StoredEvent, "id" | "data" | "created_at">): TaskProgress {
  return { id: event.id, text: text(event.data.text), at: event.created_at };
}

/** The newest thing the task said while it worked, or null when it has said nothing (yet): one request for the newest report. */
export async function readTaskProgress(client: Pick<InvisibleDotsClient, "events">, dotId: string, taskId: string): Promise<TaskProgress | null> {
  const [newest] = await readRecentEvents(client, dotId, { types: ["task.progress"], taskId, count: 1 });
  return newest === undefined ? null : progressOfEvent(newest);
}

export type ApprovalOutcome = "waiting" | "approved" | "rejected";

export type StoryStep =
  | { kind: "created"; id: number; at: string; description: string; priority: number | null }
  | { kind: "started"; id: number; at: string }
  | { kind: "progress"; id: number; at: string; text: string }
  | { kind: "tool"; id: number; at: string; tool: string; target: string; decision: string; ok: boolean; interrupted: boolean; durationMs: number }
  | { kind: "approval"; id: number; at: string; approvalId: string; tool: string; reason: string; outcome: ApprovalOutcome; note: string; always: boolean }
  | { kind: "completed"; id: number; at: string; summary: string }
  | { kind: "failed"; id: number; at: string; error: string }
  | { kind: "cancelled"; id: number; at: string };

/** The steps of one task, in the order they happened. An approval is one step: asked, and then how it was answered. */
export function storyOf(events: readonly StoredEvent[], taskId: string): StoryStep[] {
  const steps: StoryStep[] = [];
  const approvals = new Map<string, Extract<StoryStep, { kind: "approval" }>>();
  for (const event of events) {
    const base = { id: event.id, at: event.created_at };
    const d = event.data ?? {};
    if (taskIdOf(event) !== taskId) continue;
    switch (event.type) {
      case "task.created":
        steps.push({ ...base, kind: "created", description: text(d.description), priority: typeof d.priority === "number" ? d.priority : null });
        break;
      case "task.started":
        steps.push({ ...base, kind: "started" });
        break;
      case "task.progress":
        steps.push({ ...base, kind: "progress", text: text(d.text) });
        break;
      case "tool.called":
        steps.push({
          ...base,
          kind: "tool",
          tool: text(d.tool),
          target: text(d.target),
          decision: text(d.decision),
          ok: d.ok === true,
          interrupted: d.interrupted === true,
          durationMs: typeof d.duration_ms === "number" ? d.duration_ms : 0,
        });
        break;
      case "approval.requested": {
        const step: Extract<StoryStep, { kind: "approval" }> = {
          ...base,
          kind: "approval",
          approvalId: text(d.approval_id),
          tool: text(d.tool),
          reason: text(d.reason),
          outcome: "waiting",
          note: "",
          always: false,
        };
        approvals.set(step.approvalId, step);
        steps.push(step);
        break;
      }
      case "approval.resolved": {
        const step = approvals.get(text(d.approval_id));
        if (step) {
          step.outcome = d.decision === "approve" ? "approved" : "rejected";
          step.note = text(d.note);
          step.always = d.always === true;
        }
        break;
      }
      case "task.completed":
        steps.push({ ...base, kind: "completed", summary: text(d.summary) });
        break;
      case "task.failed":
        steps.push({ ...base, kind: "failed", error: text(d.error) });
        break;
      case "task.cancelled":
        steps.push({ ...base, kind: "cancelled" });
        break;
      default:
        break;
    }
  }
  return steps;
}
