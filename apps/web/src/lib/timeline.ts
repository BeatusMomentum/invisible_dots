/** Turns event rows into one-line timeline entries. */
import type { StoredEvent } from "./types";

export type Tone = "neutral" | "info" | "ok" | "warn" | "error";

export interface TimelineEntry {
  id: number;
  type: string;
  title: string;
  detail: string;
  tone: Tone;
  source: StoredEvent["source"];
  at: string;
}

const MAX_DETAIL = 280;

export function truncate(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function joined(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

function identity(data: Record<string, unknown>): string {
  const name = str(data.name);
  const id = str(data.identity_id);
  return name && id ? `${name} (${id})` : name || id;
}

export function describeEvent(event: StoredEvent): TimelineEntry {
  const d = event.data ?? {};
  const base = { id: event.id, type: event.type, source: event.source, at: event.created_at };
  const entry = (title: string, detail: string, tone: Tone = "info"): TimelineEntry => ({
    ...base,
    title,
    detail: truncate(detail),
    tone,
  });
  const type: string = event.type;
  switch (type) {
    case "agent.state":
      return entry("Agent state", str(d.state), "neutral");
    case "message.assistant":
      return entry("Assistant replied", str(d.text));
    case "task.started":
      return entry("Task started", str(d.task_id));
    case "task.progress":
      return entry("Task progress", joined(str(d.task_id) && `${str(d.task_id)}:`, str(d.text)));
    case "task.completed":
      return entry("Task completed", joined(str(d.task_id) && `${str(d.task_id)}:`, str(d.summary)), "ok");
    case "task.failed":
      return entry("Task failed", joined(str(d.task_id) && `${str(d.task_id)}:`, str(d.error)), "error");
    case "task.created":
      return entry(
        "Task created",
        joined(str(d.description), d.priority !== undefined ? `(priority ${str(d.priority)})` : ""),
      );
    case "task.cancelled":
      return entry("Task cancelled", str(d.task_id), "neutral");
    case "approval.requested":
      return entry(
        "Approval requested",
        joined(str(d.tool), str(d.permission) && `[${str(d.permission)}]`, str(d.reason) && `- ${str(d.reason)}`),
        "warn",
      );
    case "approval.resolved": {
      const decision = str(d.decision);
      return entry(
        decision === "approve" ? "Approved" : decision === "reject" ? "Rejected" : "Approval resolved",
        joined(str(d.approval_id), str(d.note) && `- ${str(d.note)}`),
        decision === "reject" ? "warn" : "ok",
      );
    }
    case "tool.called": {
      const ok = d.ok === true;
      const decision = str(d.decision);
      const duration = typeof d.duration_ms === "number" ? `${Math.round(d.duration_ms)} ms` : "";
      const outcome = decision === "deny" ? "denied" : ok ? "ok" : "failed";
      return entry(
        `Tool ${str(d.tool) || "call"}`,
        joined(outcome, duration && `in ${duration}`, str(d.permission) && `[${str(d.permission)}]`),
        decision === "deny" || !ok ? "error" : "neutral",
      );
    }
    case "browser.identity.created":
      return entry("Browser identity created", identity(d), "ok");
    case "browser.identity.deleted":
      return entry("Browser identity deleted", identity(d), "neutral");
    case "browser.identity.launched":
      return entry("Browser launched", identity(d));
    case "browser.identity.closed":
      return entry("Browser closed", identity(d), "neutral");
    case "memory.written":
      return entry("Memory written", str(d.key), "neutral");
    case "dot.created":
      return entry("Dot created", str(d.name), "ok");
    case "dot.updated":
      return entry("Configuration updated", str(d.name), "neutral");
    case "dot.deleted":
      return entry("Dot deleted", str(d.name), "warn");
    case "computer.state": {
      const state = str(d.state);
      return entry("Computer state", state, state === "ERROR" ? "error" : "neutral");
    }
    case "computer.started":
      return entry("Computer started", "", "ok");
    case "computer.stopped":
      return entry("Computer stopped", "", "neutral");
    default:
      return entry(type, JSON.stringify(d), "neutral");
  }
}

/** Merge new events into a list ordered by id, dropping duplicates (a reconnect can replay some). */
export function mergeEvents(current: readonly StoredEvent[], incoming: readonly StoredEvent[]): StoredEvent[] {
  const byId = new Map<number, StoredEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
