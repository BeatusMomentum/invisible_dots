// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * The run record: the unit of work in flight.
 *
 * A Dot runs one unit at a time, either a chat turn on the shared
 * conversation or a task on its own thread. The record is persisted in
 * `dot.db` (the `active_unit` config row), so a restart, a sleep or an
 * approval that takes a day all resume the same unit.
 */
import { CONVERSATION_THREAD } from "@invisible-dots/memory";
import type { UsageTotals } from "@invisible-dots/openrouter-client";

interface RunRecordBase {
  /**
   * The message the unit started from: the task seed, or the chat turn's
   * user message. Kept whole in every request; 0 on a record written before
   * this field existed, which means the start of the thread.
   */
  startMessageId: number;
  /**
   * Model requests started since the last assistant or summary commit. A
   * request that kills the process never reaches the persisted usage, so this
   * is what bounds the cost of a crash loop (architecture section 8.7).
   */
  requestAttempts: number;
}

export type RunRecord =
  | (RunRecordBase & { kind: "chat"; eventId: string; text: string; steps: number; usage: UsageTotals })
  | (RunRecordBase & { kind: "task"; taskId: string });

/**
 * Read a stored run record, so a corrupt row is reported instead of guessed
 * at. A record written before `startMessageId` and `requestAttempts` existed
 * gets their neutral values.
 */
export function parseRunRecord(value: unknown): RunRecord {
  assertRunRecord(value);
  const record = value as RunRecord & Partial<RunRecordBase>;
  return { ...record, startMessageId: record.startMessageId ?? 0, requestAttempts: record.requestAttempts ?? 0 };
}

function assertRunRecord(value: unknown): asserts value is Omit<RunRecord, keyof RunRecordBase> {
  if (value === null || typeof value !== "object") throw new Error("the active unit record is not an object");
  const record = value as Record<string, unknown>;
  if (record.kind === "task" && typeof record.taskId === "string" && record.taskId !== "") return;
  if (
    record.kind === "chat" &&
    typeof record.eventId === "string" &&
    typeof record.text === "string" &&
    Number.isInteger(record.steps) &&
    record.usage !== null &&
    typeof record.usage === "object"
  ) {
    return;
  }
  throw new Error("the active unit record is malformed");
}

/** The thread a unit works on. */
export function threadOf(record: RunRecord): string {
  return record.kind === "chat" ? CONVERSATION_THREAD : record.taskId;
}

/** Log fields naming a unit. */
export function describeRun(record: RunRecord): Record<string, unknown> {
  return record.kind === "chat" ? { unit: "chat", event_id: record.eventId } : { unit: "task", task_id: record.taskId };
}
