/**
 * The conversation as the chat draws it: the messages, and between them what the Dot did to answer, read from the
 * event log. The messages route and the log are two views of the same log (a message carries the id of its event), so
 * ordering by that id puts each step between the right two messages.
 *
 * Only the chat's own turns are drawn here: a tool call or an approval that names a task belongs to that task's
 * story (the Tasks page), not to the conversation.
 */
import { toolLabel, type ToolFamily } from "./events/tool-labels";
import type { ApprovalOutcome } from "./task-events";
import { mergeEvents } from "./event-log";
import type { ChatMessage, StoredEvent } from "./types";

/**
 * How a tool call ended. The engine reports a call when it has ended, so a call that is still running has no event
 * yet (the chat's working row says the Dot is busy); a call that waits for the person is the approval's step.
 */
export type ToolState = "ok" | "error" | "denied" | "interrupted";

export interface ToolStep {
  kind: "tool";
  id: number;
  at: string;
  tool: string;
  label: string;
  family: ToolFamily;
  /** What the call acted on, as the engine reported it (one line); "" when it named nothing. */
  target: string;
  state: ToolState;
  durationMs: number;
}

export interface ApprovalStep {
  kind: "approval";
  id: number;
  at: string;
  approvalId: string;
  tool: string;
  label: string;
  family: ToolFamily;
  reason: string;
  /** What the call needs the person's permission for, and with which arguments: what the approval card shows. */
  permission: string;
  arguments: Record<string, unknown>;
  outcome: ApprovalOutcome;
  /** The answer also allowed the permission for good. */
  always: boolean;
}

export type ActivityItem = ToolStep | ApprovalStep;

export type ThreadItem =
  | { kind: "user"; id: number; message: ChatMessage }
  | { kind: "assistant"; id: number; message: ChatMessage; firstOfGroup: boolean }
  | { kind: "activity"; id: number; items: ActivityItem[] };

/** The event types the chat reads besides the messages. */
export const CHAT_ACTIVITY_EVENT_TYPES: readonly string[] = ["tool.called", "approval.requested", "approval.resolved"];

export function isChatActivityEvent(event: Pick<StoredEvent, "type">): boolean {
  return CHAT_ACTIVITY_EVENT_TYPES.includes(event.type);
}

/** Runs of tool steps longer than this fold into one line the person can open. */
export const CLUSTER_AFTER = 3;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasTask(event: Pick<StoredEvent, "data">): boolean {
  return text(event.data?.task_id) !== "";
}

export function toolStateOf(data: Record<string, unknown>): ToolState {
  if (data.interrupted === true) return "interrupted";
  if (data.decision === "deny") return "denied";
  return data.ok === true ? "ok" : "error";
}

/** The steps of the chat's turns in the order they happened, from the events `isChatActivityEvent` accepts. */
export function activityOf(events: readonly StoredEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const approvals = new Map<string, ApprovalStep>();
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const d = event.data ?? {};
    const base = { id: event.id, at: event.created_at };
    switch (event.type) {
      case "tool.called": {
        if (hasTask(event)) break;
        const tool = text(d.tool);
        const { label, family } = toolLabel(tool, d.tty === true);
        items.push({
          ...base,
          kind: "tool",
          tool,
          label,
          family,
          target: text(d.target),
          state: toolStateOf(d),
          durationMs: typeof d.duration_ms === "number" ? d.duration_ms : 0,
        });
        break;
      }
      case "approval.requested": {
        if (hasTask(event)) break;
        const tool = text(d.tool);
        const { label, family } = toolLabel(tool);
        const step: ApprovalStep = {
          ...base,
          kind: "approval",
          approvalId: text(d.approval_id),
          tool,
          label,
          family,
          reason: text(d.reason),
          permission: text(d.permission),
          arguments: typeof d.arguments === "object" && d.arguments !== null && !Array.isArray(d.arguments) ? (d.arguments as Record<string, unknown>) : {},
          outcome: "waiting",
          always: false,
        };
        approvals.set(step.approvalId, step);
        items.push(step);
        break;
      }
      case "approval.resolved": {
        // It names only the approval: one that was not the chat's is not in the map.
        const step = approvals.get(text(d.approval_id));
        if (step) {
          step.outcome = d.decision === "approve" ? "approved" : "rejected";
          step.always = d.always === true;
        }
        break;
      }
      default:
        break;
    }
  }
  return items;
}

/** The thread: messages and activity merged by event id; an assistant message starts a group after anything but another assistant message. */
export function buildThread(messages: readonly ChatMessage[], events: readonly StoredEvent[]): ThreadItem[] {
  const activity = activityOf(events);
  const sortedMessages = [...messages].sort((a, b) => a.event_id - b.event_id);
  const thread: ThreadItem[] = [];
  let a = 0;
  let m = 0;
  let run: ActivityItem[] = [];
  const flush = () => {
    if (run.length > 0) thread.push({ kind: "activity", id: run[0]!.id, items: run });
    run = [];
  };
  let previousWasAssistant = false;
  while (a < activity.length || m < sortedMessages.length) {
    const nextActivity = activity[a];
    const nextMessage = sortedMessages[m];
    if (nextActivity !== undefined && (nextMessage === undefined || nextActivity.id < nextMessage.event_id)) {
      run.push(nextActivity);
      a++;
      continue;
    }
    flush();
    const message = nextMessage!;
    m++;
    if (message.role === "user") {
      thread.push({ kind: "user", id: message.event_id, message });
      previousWasAssistant = false;
    } else {
      thread.push({ kind: "assistant", id: message.event_id, message, firstOfGroup: !previousWasAssistant });
      previousWasAssistant = true;
    }
  }
  flush();
  return thread;
}

/** Fold events read from the log and live ones into the chat's list, oldest first, keeping only what the chat reads. */
export function mergeChatEvents(current: readonly StoredEvent[], incoming: readonly StoredEvent[]): StoredEvent[] {
  return mergeEvents(current, incoming.filter(isChatActivityEvent));
}

/**
 * The newest tool call or approval of the turn the Dot is in now, for the working row; null when there is none. A turn
 * starts at the person's message and ends at the Dot's answer: a step before either belongs to a turn that is over
 * (the Dot may be working again for a task, a schedule or an approval that resumed).
 */
export function lastStepSinceUser(thread: readonly ThreadItem[]): ToolStep | ApprovalStep | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const item = thread[i]!;
    if (item.kind !== "activity") return null;
    const step = item.items.at(-1);
    if (step) return step;
  }
  return null;
}

export type ActivityGroup = { kind: "single"; item: ActivityItem } | { kind: "cluster"; steps: ToolStep[] };

/** Consecutive tool steps beyond `CLUSTER_AFTER` fold into one cluster; approvals always stand alone. */
export function groupActivity(items: readonly ActivityItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let run: ToolStep[] = [];
  const flush = () => {
    if (run.length > CLUSTER_AFTER) groups.push({ kind: "cluster", steps: run });
    else for (const step of run) groups.push({ kind: "single", item: step });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      run.push(item);
      continue;
    }
    flush();
    groups.push({ kind: "single", item });
  }
  flush();
  return groups;
}

/** What a folded run says of itself: how many steps, and how many did not end well. */
export function clusterSummary(steps: readonly ToolStep[]): string {
  const problems = steps.filter((step) => step.state !== "ok").length;
  const base = `${steps.length} steps`;
  return problems === 0 ? base : `${base}, ${problems} did not go through`;
}

/** A message the person sent from this page that the log may not show yet. */
export interface PendingMessage {
  key: string;
  text: string;
  /** The id of the logged `user.message` event, once the API answered; null while it is on its way. */
  eventId: number | null;
}

/** The pending messages the log does not hold yet: one that was answered is settled by the event it was logged as. */
export function unsettled(pending: readonly PendingMessage[], messages: readonly ChatMessage[]): PendingMessage[] {
  const logged = new Set(messages.map((message) => message.event_id));
  return pending.filter((p) => p.eventId === null || !logged.has(p.eventId));
}
