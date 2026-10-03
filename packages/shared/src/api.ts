/**
 * The wire format of the control-plane API (architecture section 9.6). The
 * database repositories return these shapes and the API serializes them as
 * they are, so a record looks the same in PostgreSQL, over HTTP and in the
 * clients. Timestamps are ISO 8601 strings in UTC.
 *
 * Browser-safe: type imports only. The SDK re-exports this module.
 */
import type { DotConfig } from "./config.js";
import type { StoredEvent } from "./events.js";
import type { BrowserIdentity, SystemAnswer } from "./protocol.js";
import type { ApprovalStatus, DotState, TaskState, VmState } from "./states.js";

export interface DotRecord {
  id: string;
  name: string;
  config: DotConfig;
  status: DotState;
  /** Why the Dot is in ERROR; null otherwise. */
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** A Dot as the list and detail routes return it: the record plus its computer state. */
export interface DotSummary extends DotRecord {
  computer_state: VmState | null;
}

export interface ComputerRecord {
  dot_id: string;
  /** The QEMU `-name` of the VM (see vmName in protocol.ts). */
  vm_name: string;
  /** The host's 127.0.0.1 port forwarded to dot-agentd, chosen at each start; null while no QEMU process runs. */
  guest_port: number | null;
  /** The QEMU process id; null while none runs. */
  pid: number | null;
  state: VmState;
  golden_image: string | null;
  runtime_image: string | null;
  event_cursor: number;
  last_active_at: string | null;
  /** The last lifecycle failure (start, READY procedure, stop), null after a success. */
  last_error: string | null;
  updated_at: string;
}

/** `GET /api/dots/:id/computer`: the stored record plus what the control plane knows live. */
export interface ComputerAnswer extends ComputerRecord {
  /** Whether the READY procedure (section 9.3) completed since the computer last started. */
  ready: boolean;
  /** `GET /v1/system` of the guest while it is READY; null when stopped or when the guest did not answer. */
  system: SystemAnswer | null;
}

export interface TaskRecord {
  id: string;
  dot_id: string;
  description: string;
  priority: number;
  status: TaskState;
  created_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
}

export interface TaskRunRecord {
  id: string;
  task_id: string;
  started_at: string;
  delivered_at: string | null;
  finished_at: string | null;
  outcome: string | null;
}

export interface ApprovalRecord {
  id: string;
  dot_id: string;
  task_id: string | null;
  tool: string;
  permission: string;
  arguments: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** One turn of the Dot's conversation, rebuilt from the event log. */
export interface ConversationMessage {
  event_id: number;
  role: "user" | "assistant";
  text: string;
  in_reply_to: string | null;
  created_at: string;
}

export interface CreateDotRequest {
  /** YAML text or an already-decoded object (section 7). */
  config: string | Record<string, unknown>;
}

export interface PatchDotRequest {
  config: string | Record<string, unknown>;
}

export interface CreateTaskRequest {
  description: string;
  /** Higher runs first; default 0. */
  priority?: number;
  /** ISO 8601; the task is not dispatched before this time. */
  scheduled_at?: string;
}

export interface MessageAnswer {
  /** The id of the `user.message` event the message was delivered as. */
  message_id: string;
  event_id: number;
  /** `queued` when the computer has to wake up first. */
  delivery: "delivered" | "queued";
}

export interface ApprovalDecisionRequest {
  note?: string;
}

export interface PutOpenRouterSecretRequest {
  value: string;
  dot_id?: string;
}

export interface HealthResponse {
  status: "ok";
  database: "ok";
  version: string;
  /** Whether a global OpenRouter key is stored; `invisible-dots doctor` reports it (section 11.1). */
  openrouter_configured: boolean;
}

export interface DotsAnswer {
  dots: DotSummary[];
}

export interface TasksAnswer {
  tasks: TaskRecord[];
}

export interface ApprovalsAnswer {
  approvals: ApprovalRecord[];
}

export interface MessagesAnswer {
  messages: ConversationMessage[];
}

export interface EventsAnswer {
  events: StoredEvent[];
}

export interface IdentitiesAnswer {
  identities: BrowserIdentity[];
}

/** Lifecycle requests are accepted and run in the background; progress arrives as `computer.state` events. */
export interface AcceptedAnswer {
  accepted: true;
}
