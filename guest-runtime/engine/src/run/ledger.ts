// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * The run ledger: the lifecycle of the unit in flight over `dot.db`.
 *
 * {@link RunLedger} starts a unit, counts its model turns and usage, and
 * clears it when the unit ends. Every write is a statement in the caller's
 * transaction (or its own), so the record never disagrees with the thread
 * and the task row it describes.
 */
import { CONVERSATION_THREAD, type DotStore } from "@invisible-dots/memory";
import { UsageAccumulator, type Usage } from "@invisible-dots/openrouter-client";
import type { TaskQueue, TaskRecord } from "@invisible-dots/task-runtime";
import type { ThreadMessage } from "../types.js";
import { parseRunRecord, type RunRecord } from "./record.js";

const KEY_ACTIVE_UNIT = "active_unit";

/** Model requests one step may start before the unit fails (architecture section 8.7). */
export const MAX_REQUEST_ATTEMPTS = 3;

export class RunLedger {
  constructor(
    private readonly store: DotStore,
    private readonly queue: TaskQueue,
  ) {}

  /** The unit in flight, if any. */
  get(): RunRecord | undefined {
    const value = this.store.getConfig<unknown>(KEY_ACTIVE_UNIT);
    return value === undefined ? undefined : parseRunRecord(value);
  }

  /**
   * After a crash between starting a task and recording it as active, a
   * RUNNING task has no record: adopt it.
   */
  adoptOrphan(): RunRecord | undefined {
    const current = this.get();
    if (current) return current;
    const orphan = this.queue.inFlight();
    if (!orphan) return undefined;
    const seed = this.store.listMessages(orphan.id)[0];
    const record: RunRecord = { kind: "task", taskId: orphan.id, startMessageId: seed?.id ?? 0, requestAttempts: 0 };
    this.store.setConfig(KEY_ACTIVE_UNIT, record);
    return record;
  }

  /** Start a chat turn: its user message joins the conversation in the same transaction. */
  startChat(eventId: string, text: string): RunRecord {
    return this.store.transaction(() => {
      const message = this.store.appendMessage<ThreadMessage>(CONVERSATION_THREAD, { role: "user", content: text });
      const record: RunRecord = {
        kind: "chat",
        eventId,
        text,
        steps: 0,
        usage: new UsageAccumulator().toJSON(),
        startMessageId: message.id,
        requestAttempts: 0,
      };
      this.store.setConfig(KEY_ACTIVE_UNIT, record);
      return record;
    });
  }

  /** Start a queued task with its seed message, and announce it. */
  startTask(task: TaskRecord, seed: string): RunRecord {
    return this.store.transaction(() => {
      this.queue.start(task.id);
      const message = this.store.appendMessage<ThreadMessage>(task.id, { role: "user", content: seed });
      const record: RunRecord = { kind: "task", taskId: task.id, startMessageId: message.id, requestAttempts: 0 };
      this.store.setConfig(KEY_ACTIVE_UNIT, record);
      this.store.appendEvent("task.started", { task_id: task.id });
      return record;
    });
  }

  /** Give a record written before `startMessageId` existed its start message. */
  setStartMessage(messageId: number): void {
    const current = this.get();
    if (current) this.store.setConfig(KEY_ACTIVE_UNIT, { ...current, startMessageId: messageId });
  }

  /** Model turns the unit has taken. */
  steps(record: RunRecord): number {
    if (record.kind === "chat") {
      const current = this.get();
      return current?.kind === "chat" ? current.steps : record.steps;
    }
    return this.queue.get(record.taskId)?.steps ?? 0;
  }

  /**
   * One more model request of the current step, in its own transaction
   * before the request is sent. Returns false, writing nothing, when the
   * step already started `MAX_REQUEST_ATTEMPTS` requests: the unit fails
   * instead of paying for the same response again.
   */
  beginRequest(): boolean {
    const current = this.get();
    if (!current) return true;
    if (current.requestAttempts >= MAX_REQUEST_ATTEMPTS) return false;
    this.store.setConfig(KEY_ACTIVE_UNIT, { ...current, requestAttempts: current.requestAttempts + 1 });
    return true;
  }

  /** Give back the attempt of a request the agent abandoned on purpose (a sleep, a cancel). */
  abandonRequest(): void {
    const current = this.get();
    if (current && current.requestAttempts > 0) {
      this.store.setConfig(KEY_ACTIVE_UNIT, { ...current, requestAttempts: current.requestAttempts - 1 });
    }
  }

  /** A response was committed: the next step starts with no attempts. */
  resetRequests(): void {
    const current = this.get();
    if (current && current.requestAttempts !== 0) this.store.setConfig(KEY_ACTIVE_UNIT, { ...current, requestAttempts: 0 });
  }

  /**
   * The cost cap of a unit: its spend as persisted with every response, the
   * summary and flush calls included. Returns the reason to stop, or null.
   * A chat turn is capped on its own.
   */
  costCapReached(record: RunRecord, capUsd: number): string | null {
    const current = this.get();
    const cost =
      record.kind === "chat"
        ? ((current?.kind === "chat" ? current : record).usage.cost ?? 0)
        : (this.queue.get(record.taskId)?.usage?.cost ?? 0);
    return cost >= capUsd ? `stopped: cost cap reached (${cost.toFixed(4)} USD of ${capUsd.toFixed(2)})` : null;
  }

  /** Usage of a request that is not a step (a memory flush, a summary): it counts toward cost, not steps. */
  addUsage(record: RunRecord, usage: Usage): void {
    this.store.transaction(() => {
      const current = this.get();
      if (record.kind === "chat") {
        const base = current?.kind === "chat" ? current : record;
        const total = new UsageAccumulator(base.usage);
        total.add(usage);
        this.store.setConfig(KEY_ACTIVE_UNIT, { ...base, usage: total.toJSON() });
        return;
      }
      const task = this.queue.get(record.taskId);
      const total = new UsageAccumulator(task?.usage ?? undefined);
      total.add(usage);
      this.store.updateTask(record.taskId, { usage: total.toJSON() });
    });
  }

  /** Count one more model turn and its usage; part of the assistant commit. */
  countStep(record: RunRecord, usage: Usage): void {
    const current = this.get();
    if (record.kind === "chat") {
      const base = current?.kind === "chat" ? current : record;
      const total = new UsageAccumulator(base.usage);
      total.add(usage);
      this.store.setConfig(KEY_ACTIVE_UNIT, { ...base, steps: base.steps + 1, usage: total.toJSON(), requestAttempts: 0 });
      return;
    }
    const task = this.queue.get(record.taskId);
    const total = new UsageAccumulator(task?.usage ?? undefined);
    total.add(usage);
    this.queue.countStep(record.taskId, total.toJSON());
    this.resetRequests();
  }

  /** The unit ended: forget it. */
  clear(): void {
    this.store.deleteConfig(KEY_ACTIVE_UNIT);
  }
}
