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
 * its transaction committed. No `await` happens inside a transaction.
 *
 * The commit points (architecture section 8.7):
 *  - assistant: the model's message, the step and its usage, `task.progress`;
 *  - intent (A): the call about to run, before it starts;
 *  - result (B): the tool message, the intent and the approval deleted,
 *    `tool.called`, once the call returned;
 *  - completion, failure or cancel of the unit, which answers every call the
 *    unit left open, so a thread never keeps a call without its result.
 */
import { CONVERSATION_THREAD, type DotStore, type StoredMessage, type ToolIntentRecord } from "@invisible-dots/memory";
import type { AssistantMessage, Usage } from "@invisible-dots/openrouter-client";
import type { OutboundEventDataMap } from "@invisible-dots/shared";
import type { TaskQueue } from "@invisible-dots/task-runtime";
import type { DurableApprovalLedger } from "../approval/durable.js";
import { classifyIntent, interruptedText } from "../dot/intents.js";
import { NOT_EXECUTED_TEXT, THREAD_READ_LIMIT, openCalls } from "../dot/request.js";
import type { RunLedger } from "../run/ledger.js";
import { threadOf, type RunRecord } from "../run/record.js";
import type { FaultSeam, StoredToolMessage, ThreadMessage } from "../types.js";

/** Where a call sits: its assistant message and its index in that message's calls. */
export interface CallPosition {
  messageId: number;
  callIndex: number;
}

export class Checkpoint {
  constructor(
    private readonly store: DotStore,
    private readonly queue: TaskQueue,
    private readonly ledger: RunLedger,
    private readonly approvals: DurableApprovalLedger,
    private readonly faults: FaultSeam,
  ) {}

  /** The newest `limit` messages of a thread, oldest first, with their ids. */
  recent(thread: string, limit: number): StoredMessage<ThreadMessage>[] {
    return this.store.listMessages<ThreadMessage>(thread, { limit });
  }

  /** The model answered: its message, the step and its usage (which ends the step's request attempts), the progress text of a task. */
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

  /** The intent of a call, if one was committed and not yet answered. */
  intentOf(thread: string, position: CallPosition): ToolIntentRecord | undefined {
    return this.store.getIntent(thread, position.messageId, position.callIndex);
  }

  /** Transaction A: the call is about to run. Returns the intent, whose `attempts` counts this start. */
  intent(record: RunRecord, position: CallPosition, call: { toolCallId: string; tool: string; permission: string; decision: string }): ToolIntentRecord {
    return this.store.transaction(() => {
      this.faults.at("intent:writing");
      return this.store.recordIntent({ thread: threadOf(record), ...position, ...call });
    });
  }

  /** Transaction B: the call has its result. Written whenever the call returned, even if the unit was aborted meanwhile. */
  toolResult(record: RunRecord, position: CallPosition, message: StoredToolMessage, called: OutboundEventDataMap["tool.called"]): void {
    const thread = threadOf(record);
    this.store.transaction(() => {
      this.store.appendMessage<ThreadMessage>(thread, message);
      this.faults.at("result:writing");
      this.store.deleteIntent(thread, position.messageId, position.callIndex);
      const approval = this.approvals.forCall(thread, position.messageId, position.callIndex);
      if (approval) this.approvals.consume(approval.approvalId);
      this.store.appendEvent("tool.called", called);
    });
  }

  /** A call a crash interrupted: its result says so, its intent and approval go, and `tool.called` carries what was decided when it started. */
  interrupted(record: RunRecord, intent: ToolIntentRecord, text: string): void {
    this.store.transaction(() => {
      this.store.appendMessage<ThreadMessage>(intent.thread, { role: "tool", tool_call_id: intent.toolCallId, content: text });
      this.store.deleteIntent(intent.thread, intent.messageId, intent.callIndex);
      const approval = this.approvals.forCall(intent.thread, intent.messageId, intent.callIndex);
      if (approval) this.approvals.consume(approval.approvalId);
      this.store.appendEvent("tool.called", {
        ...(record.kind === "task" ? { task_id: record.taskId } : {}),
        tool: intent.tool,
        permission: intent.permission,
        decision: intent.decision as OutboundEventDataMap["tool.called"]["decision"],
        ok: false,
        duration_ms: 0,
        interrupted: true,
      });
    });
  }

  /** A note for the model from the engine itself, such as a loop warning. */
  notice(record: RunRecord, text: string): void {
    this.store.appendMessage<ThreadMessage>(threadOf(record), { role: "user", content: text });
  }

  /** The unit answered: the chat reply or the task's summary, and the record cleared. */
  complete(record: RunRecord, text: string): void {
    this.store.transaction(() => {
      // First, so the results follow the calls they answer.
      this.#closeOpenCalls(record);
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
      // First, so the results follow the calls they answer.
      this.#closeOpenCalls(record);
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
  drop(record: RunRecord): void {
    this.store.transaction(() => {
      this.#closeOpenCalls(record);
      this.approvals.dropThread(threadOf(record));
      this.ledger.clear();
    });
  }

  /**
   * Answer every call the newest assistant message of the unit's thread
   * left open, and delete the thread's intents. A call with an intent may
   * have run: it is reported as interrupted, with its `tool.called`. Any
   * other call never started: `Not executed`.
   */
  #closeOpenCalls(record: RunRecord): void {
    const thread = threadOf(record);
    const open = openCalls(this.recent(thread, THREAD_READ_LIMIT));
    for (const { call, index } of open?.calls ?? []) {
      const intent = this.store.getIntent(thread, open!.messageId, index);
      if (intent) {
        const approval = this.approvals.forCall(thread, intent.messageId, intent.callIndex);
        const verdict = classifyIntent(intent);
        this.interrupted(record, intent, interruptedText(verdict === "interrupted twice" ? verdict : "interrupted", approval?.status === "approved"));
      } else {
        this.store.appendMessage<ThreadMessage>(thread, { role: "tool", tool_call_id: call.id, content: NOT_EXECUTED_TEXT });
      }
    }
    this.store.deleteIntentsForThread(thread);
  }
}
