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
import { assertRunRecord, type RunRecord } from "./record.js";

const KEY_ACTIVE_UNIT = "active_unit";

export class RunLedger {
  constructor(
    private readonly store: DotStore,
    private readonly queue: TaskQueue,
  ) {}

  /** The unit in flight, if any. */
  get(): RunRecord | undefined {
    const value = this.store.getConfig<unknown>(KEY_ACTIVE_UNIT);
    if (value === undefined) return undefined;
    assertRunRecord(value);
    return value;
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
    const record: RunRecord = { kind: "task", taskId: orphan.id };
    this.store.setConfig(KEY_ACTIVE_UNIT, record);
    return record;
  }

  /** Start a chat turn: its user message joins the conversation in the same transaction. */
  startChat(eventId: string, text: string): RunRecord {
    const record: RunRecord = { kind: "chat", eventId, text, steps: 0, usage: new UsageAccumulator().toJSON() };
    this.store.transaction(() => {
      this.store.appendMessage<ThreadMessage>(CONVERSATION_THREAD, { role: "user", content: text });
      this.store.setConfig(KEY_ACTIVE_UNIT, record);
    });
    return record;
  }

  /** Start a queued task with its seed message, and announce it. */
  startTask(task: TaskRecord, seed: string): RunRecord {
    const record: RunRecord = { kind: "task", taskId: task.id };
    this.store.transaction(() => {
      this.queue.start(task.id);
      this.store.appendMessage<ThreadMessage>(task.id, { role: "user", content: seed });
      this.store.setConfig(KEY_ACTIVE_UNIT, record);
      this.store.appendEvent("task.started", { task_id: task.id });
    });
    return record;
  }

  /** Model turns the unit has taken. */
  steps(record: RunRecord): number {
    if (record.kind === "chat") {
      const current = this.get();
      return current?.kind === "chat" ? current.steps : record.steps;
    }
    return this.queue.get(record.taskId)?.steps ?? 0;
  }

  /** Count one more model turn and its usage; part of the assistant commit. */
  countStep(record: RunRecord, usage: Usage): void {
    if (record.kind === "chat") {
      const current = this.get();
      const base = current?.kind === "chat" ? current : record;
      const total = new UsageAccumulator(base.usage);
      total.add(usage);
      this.store.setConfig(KEY_ACTIVE_UNIT, { ...base, steps: base.steps + 1, usage: total.toJSON() });
      return;
    }
    const task = this.queue.get(record.taskId);
    const total = new UsageAccumulator(task?.usage ?? undefined);
    total.add(usage);
    this.queue.countStep(record.taskId, total.toJSON());
  }

  /** The unit ended: forget it. */
  clear(): void {
    this.store.deleteConfig(KEY_ACTIVE_UNIT);
  }
}
