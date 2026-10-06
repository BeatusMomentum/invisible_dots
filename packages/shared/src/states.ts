/** Agent runtime states (architecture section 8.1). */
export const AGENT_STATES = [
  "IDLE",
  "THINKING",
  "PLANNING",
  "EXECUTING",
  "WAITING_APPROVAL",
  "DONE",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** States of a Dot's QEMU virtual machine, stored in `computers.state` (section 9.3). */
export const VM_STATES = [
  "PROVISIONING",
  "STARTING",
  "RUNNING",
  "IDLE",
  "STOPPING",
  "STOPPED",
  "ERROR",
  "DELETING",
] as const;
export type VmState = (typeof VM_STATES)[number];

/** Dot states, stored in `dots.status` (section 9.3). */
export const DOT_STATES = [
  "CREATING",
  "READY",
  "IDLE",
  "RUNNING",
  "WAITING_APPROVAL",
  "ERROR",
  "DISABLED",
] as const;
export type DotState = (typeof DOT_STATES)[number];

/** Task states, used on the host (`tasks.status`) and in the guest queue (section 9.3). */
export const TASK_STATES = [
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** A task in one of these states never runs again. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["COMPLETED", "FAILED", "CANCELLED"];

/** How many of a Dot's tasks (the newest) `GET /api/dots/:id/tasks` answers with; older ones are not reachable. */
export const TASK_LIST_LIMIT = 200;

/** How many messages (the OLDEST) `GET /api/dots/:id/messages` answers with; later ones are not reachable through it. */
export const CONVERSATION_LIST_LIMIT = 500;

/**
 * `approvals.status` (section 9.1). An approval is `expired` when its task
 * ended before anybody decided: nothing waits for the decision any more.
 */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** `events.source` (section 9.1). */
export const EVENT_SOURCES = ["host", "guest"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === "string" && (AGENT_STATES as readonly string[]).includes(value);
}

export function isVmState(value: unknown): value is VmState {
  return typeof value === "string" && (VM_STATES as readonly string[]).includes(value);
}

export function isDotState(value: unknown): value is DotState {
  return typeof value === "string" && (DOT_STATES as readonly string[]).includes(value);
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}
