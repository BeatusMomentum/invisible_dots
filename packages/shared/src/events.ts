/**
 * Event shapes of architecture section 5.4: inbound (host to guest), outbound
 * (guest to host, persisted in the guest outbox) and the control plane's own
 * host events.
 */
import { z } from "zod";
import { AGENT_STATES, type AgentState, type EventSource, type VmState } from "./states.js";
import { PERMISSIONS, type Permission } from "./tools.js";

export const INBOUND_EVENT_TYPES = ["user.message", "task.created", "approval.received", "system.event"] as const;
export type InboundEventType = (typeof INBOUND_EVENT_TYPES)[number];

/**
 * The `system.event` name the host sends when the user cancels a task the
 * guest already has; `data` is `{ task_id }`. The contract has no inbound
 * cancel type, so it travels as a system event.
 */
export const TASK_CANCELLED_SYSTEM_EVENT = "task.cancelled";

export const OUTBOUND_EVENT_TYPES = [
  "agent.state",
  "message.assistant",
  "task.started",
  "task.progress",
  "task.completed",
  "task.failed",
  "approval.requested",
  "tool.called",
  "browser.identity.created",
  "browser.identity.deleted",
  "browser.identity.launched",
  "browser.identity.closed",
  "memory.written",
] as const;
export type OutboundEventType = (typeof OUTBOUND_EVENT_TYPES)[number];

export const HOST_EVENT_TYPES = [
  "dot.created",
  "dot.updated",
  "dot.deleted",
  "computer.state",
  "computer.started",
  "computer.stopped",
  "task.created",
  "task.cancelled",
  "approval.resolved",
] as const;
export type HostEventType = (typeof HOST_EVENT_TYPES)[number];

/** Every type that can appear in the host event log. */
export type EventType = OutboundEventType | HostEventType;

export type ApprovalDecision = "approve" | "reject";
export type PolicyDecision = "allow" | "ask" | "deny";

export interface InboundEventDataMap {
  "user.message": { text: string };
  "task.created": { task_id: string; description: string; priority: number };
  "approval.received": { approval_id: string; decision: ApprovalDecision; note?: string };
  "system.event": { name: string; data: Record<string, unknown> };
}

export interface BrowserIdentityEventData {
  identity_id: string;
  name: string;
}

export interface ApprovalRequestedData {
  approval_id: string;
  task_id?: string;
  tool: string;
  permission: Permission;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface OutboundEventDataMap {
  "agent.state": { state: AgentState };
  "message.assistant": { text: string; in_reply_to?: string };
  "task.started": { task_id: string };
  "task.progress": { task_id: string; text: string };
  "task.completed": { task_id: string; summary: string };
  "task.failed": { task_id: string; error: string };
  "approval.requested": ApprovalRequestedData;
  "tool.called": {
    task_id?: string;
    tool: string;
    /** Empty when the model called a tool the registry does not know (always denied). */
    permission: string;
    decision: PolicyDecision;
    ok: boolean;
    duration_ms: number;
  };
  "browser.identity.created": BrowserIdentityEventData;
  "browser.identity.deleted": BrowserIdentityEventData;
  "browser.identity.launched": BrowserIdentityEventData;
  "browser.identity.closed": BrowserIdentityEventData;
  "memory.written": { key: string };
}

/**
 * Data of host events. The contract fixes only `computer.state`; the others
 * carry whatever identifies their subject, and the dot id is always the
 * event's own `dot_id` column.
 */
export interface HostEventDataMap {
  "dot.created": { name: string; [key: string]: unknown };
  "dot.updated": { name: string; [key: string]: unknown };
  "dot.deleted": { name: string; [key: string]: unknown };
  "computer.state": { state: VmState };
  "computer.started": Record<string, unknown>;
  "computer.stopped": Record<string, unknown>;
  "task.created": { task_id: string; description: string; priority: number };
  "task.cancelled": { task_id: string };
  "approval.resolved": { approval_id: string; decision: ApprovalDecision; note?: string };
}

export type InboundEvent<T extends InboundEventType = InboundEventType> = {
  [K in T]: { id: string; type: K; ts: string; data: InboundEventDataMap[K] };
}[T];

export type OutboundEvent<T extends OutboundEventType = OutboundEventType> = {
  [K in T]: { seq: number; id: string; type: K; ts: string; data: OutboundEventDataMap[K] };
}[T];

export type HostEvent<T extends HostEventType = HostEventType> = {
  [K in T]: { type: K; data: HostEventDataMap[K] };
}[T];

/** A row of the host `events` table, as the API returns it and the SSE stream sends it. */
export interface StoredEvent {
  id: number;
  dot_id: string;
  type: EventType;
  data: Record<string, unknown>;
  source: EventSource;
  guest_seq: number | null;
  created_at: string;
}

const isoTimestamp = z.iso.datetime({ offset: true });
const nonEmpty = z.string().min(1);

const inboundBase = { id: nonEmpty, ts: isoTimestamp };

export const inboundEventSchema = z.discriminatedUnion("type", [
  z.object({ ...inboundBase, type: z.literal("user.message"), data: z.object({ text: nonEmpty }) }),
  z.object({
    ...inboundBase,
    type: z.literal("task.created"),
    data: z.object({ task_id: nonEmpty, description: nonEmpty, priority: z.number().int() }),
  }),
  z.object({
    ...inboundBase,
    type: z.literal("approval.received"),
    data: z.object({
      approval_id: nonEmpty,
      decision: z.enum(["approve", "reject"]),
      note: z.string().optional(),
    }),
  }),
  z.object({
    ...inboundBase,
    type: z.literal("system.event"),
    data: z.object({ name: nonEmpty, data: z.record(z.string(), z.unknown()) }),
  }),
]);

/** Validate an inbound event; throws with every problem listed. */
export function parseInboundEvent(value: unknown): InboundEvent {
  const result = inboundEventSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid inbound event: ${detail}`);
  }
  return result.data as InboundEvent;
}

const outboundBase = { seq: z.number().int().positive(), id: nonEmpty, ts: isoTimestamp };
const identityData = z.object({ identity_id: nonEmpty, name: z.string() });
const permission = z.enum(PERMISSIONS);

export const outboundEventSchema = z.discriminatedUnion("type", [
  z.object({ ...outboundBase, type: z.literal("agent.state"), data: z.object({ state: z.enum(AGENT_STATES) }) }),
  z.object({
    ...outboundBase,
    type: z.literal("message.assistant"),
    data: z.object({ text: z.string(), in_reply_to: z.string().optional() }),
  }),
  z.object({ ...outboundBase, type: z.literal("task.started"), data: z.object({ task_id: nonEmpty }) }),
  z.object({
    ...outboundBase,
    type: z.literal("task.progress"),
    data: z.object({ task_id: nonEmpty, text: z.string() }),
  }),
  z.object({
    ...outboundBase,
    type: z.literal("task.completed"),
    data: z.object({ task_id: nonEmpty, summary: z.string() }),
  }),
  z.object({
    ...outboundBase,
    type: z.literal("task.failed"),
    data: z.object({ task_id: nonEmpty, error: z.string() }),
  }),
  z.object({
    ...outboundBase,
    type: z.literal("approval.requested"),
    data: z.object({
      approval_id: nonEmpty,
      task_id: z.string().optional(),
      tool: nonEmpty,
      permission,
      arguments: z.record(z.string(), z.unknown()),
      reason: z.string(),
    }),
  }),
  z.object({
    ...outboundBase,
    type: z.literal("tool.called"),
    data: z.object({
      task_id: z.string().optional(),
      tool: nonEmpty,
      permission: z.string(),
      decision: z.enum(["allow", "ask", "deny"]),
      ok: z.boolean(),
      duration_ms: z.number().nonnegative(),
    }),
  }),
  z.object({ ...outboundBase, type: z.literal("browser.identity.created"), data: identityData }),
  z.object({ ...outboundBase, type: z.literal("browser.identity.deleted"), data: identityData }),
  z.object({ ...outboundBase, type: z.literal("browser.identity.launched"), data: identityData }),
  z.object({ ...outboundBase, type: z.literal("browser.identity.closed"), data: identityData }),
  z.object({ ...outboundBase, type: z.literal("memory.written"), data: z.object({ key: nonEmpty }) }),
]);

/** Validate an outbound event read from the guest stream; throws with every problem listed. */
export function parseOutboundEvent(value: unknown): OutboundEvent {
  const result = outboundEventSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid outbound event: ${detail}`);
  }
  return result.data as OutboundEvent;
}

export function isInboundEventType(value: unknown): value is InboundEventType {
  return typeof value === "string" && (INBOUND_EVENT_TYPES as readonly string[]).includes(value);
}

export function isOutboundEventType(value: unknown): value is OutboundEventType {
  return typeof value === "string" && (OUTBOUND_EVENT_TYPES as readonly string[]).includes(value);
}

export function isHostEventType(value: unknown): value is HostEventType {
  return typeof value === "string" && (HOST_EVENT_TYPES as readonly string[]).includes(value);
}
