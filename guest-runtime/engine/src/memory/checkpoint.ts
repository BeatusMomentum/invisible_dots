// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Durable checkpoints over `dot.db`.
 *
 * There is no snapshot: the thread itself is the checkpoint. Each boundary
 * the runner crosses is one synchronous SQLite transaction that appends what
 * happened and writes the outbox rows describing it, so a crash leaves either
 * all of a boundary or none of it, and an event reaches the host only after
 * its transaction committed.
 */
import { CONVERSATION_THREAD, type DotStore } from "@invisible-dots/memory";
import type { AssistantMessage, Usage } from "@invisible-dots/openrouter-client";
import type { OutboundEventDataMap } from "@invisible-dots/shared";
import type { TaskQueue } from "@invisible-dots/task-runtime";
import type { DurableApprovalLedger } from "../approval/durable.js";
import type { RunLedger } from "../run/ledger.js";
import { threadOf, type RunRecord } from "../run/record.js";
import type { StoredToolMessage, ThreadMessage } from "../types.js";

export class Checkpoint {
  constructor(
    private readonly store: DotStore,
    private readonly queue: TaskQueue,
    private readonly ledger: RunLedger,
    private readonly approvals: DurableApprovalLedger,
  ) {}

  /** The newest `limit` messages of a thread, oldest first. */
  recent(thread: string, limit: number): ThreadMessage[] {
    return this.store.listMessages<ThreadMessage>(thread, { limit }).map((m) => m.message);
  }

  /** The model answered: its message, the step and its usage, and the progress text of a task. */
  assistant(record: RunRecord, message: AssistantMessage, usage: Usage): void {
    this.store.transaction(() => {
      this.store.appendMessage<ThreadMessage>(threadOf(record), message);
      this.ledger.countStep(record, usage);
      const text = message.content ?? "";
      if (record.kind === "task" && (message.tool_calls?.length ?? 0) > 0 && text.trim() !== "") {
        this.store.appendEvent("task.progress", { task_id: record.taskId, text });
      }
    });
  }

  /** A tool call has its result: the tool message, its approval consumed, `tool.called`. */
  toolResult(record: RunRecord, message: StoredToolMessage, called: OutboundEventDataMap["tool.called"]): void {
    this.store.transaction(() => {
      this.store.appendMessage<ThreadMessage>(threadOf(record), message);
      const approval = this.approvals.forCall(message.tool_call_id);
      if (approval) this.approvals.consume(approval.approvalId);
      this.store.appendEvent("tool.called", called);
    });
  }

  /** A note for the model from the engine itself, such as a loop warning. */
  notice(record: RunRecord, text: string): void {
    this.store.appendMessage<ThreadMessage>(threadOf(record), { role: "user", content: text });
  }

  /** The unit answered: the chat reply or the task's summary, and the record cleared. */
  complete(record: RunRecord, text: string): void {
    this.store.transaction(() => {
      if (record.kind === "chat") {
        this.store.appendEvent("message.assistant", { text, in_reply_to: record.eventId });
        this.store.markInboundProcessed(record.eventId);
      } else {
        const task = this.queue.complete(record.taskId, text);
        this.store.appendEvent("task.completed", { task_id: record.taskId, summary: text });
        // The chat should know what its tasks concluded.
        this.store.appendMessage<ThreadMessage>(CONVERSATION_THREAD, {
          role: "assistant",
          content: `[Task ${task.id} completed: ${task.description}]\n${text}`,
        });
      }
      this.ledger.clear();
    });
  }

  /** The unit failed: the owner is told why, and the record cleared. */
  fail(record: RunRecord, error: string): void {
    this.store.transaction(() => {
      if (record.kind === "chat") {
        const text = `I could not answer: ${error}`;
        this.store.appendMessage<ThreadMessage>(CONVERSATION_THREAD, { role: "assistant", content: text });
        this.store.appendEvent("message.assistant", { text, in_reply_to: record.eventId });
        this.store.markInboundProcessed(record.eventId);
      } else {
        const task = this.queue.get(record.taskId);
        if (task && task.status !== "CANCELLED" && task.status !== "COMPLETED" && task.status !== "FAILED") {
          this.queue.fail(record.taskId, error);
          this.store.appendEvent("task.failed", { task_id: record.taskId, error });
        }
      }
      this.approvals.dropThread(threadOf(record));
      this.ledger.clear();
    });
  }

  /** A unit that ended without an answer of its own (a cancelled task). */
  drop(): void {
    this.ledger.clear();
  }
}
