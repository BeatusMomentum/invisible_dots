// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Core conversation loop engine.
 *
 * {@link AgentRunner} drives one unit of work (a chat turn or a task) on its
 * thread in `dot.db`. It handles:
 *  - sending the thread to the model
 *  - executing the tool calls of the answer one at a time, in the model's
 *    order, through the policy gate, the approval ledger and the
 *    {@link ToolExecutor}, each with its intent committed before it starts
 *  - appending tool results and looping back until the model answers without
 *    tool calls
 *  - counting turns, usage and the attempts of each model request
 *
 * The phase is never held in memory: it is derived from the thread. A newest
 * assistant message with calls that have no result yet means "executing
 * tools"; anything else means "awaiting the model". Every boundary is a
 * checkpoint, so a restart resumes exactly where the last commit left off,
 * and a call whose intent survived a crash is classified before anything else
 * runs (architecture section 8.7).
 */
import { parseToolCall, type ChatModel, type ParsedToolCall } from "@invisible-dots/openrouter-client";
import type { StoredMessage } from "@invisible-dots/memory";
import type { AgentState, DotRuntimeConfig, OutboundEventDataMap, Permission, PolicyDecision } from "@invisible-dots/shared";
import type { DurableApprovalLedger } from "../approval/durable.js";
import { decideTool } from "../dot/gate.js";
import { callKey, classifyIntent, interruptedText } from "../dot/intents.js";
import { THREAD_READ_LIMIT, openCalls, type OpenCall } from "../dot/request.js";
import { UnitAbort, abortReason, throwIfAborted } from "../errors.js";
import type { CallPosition, Checkpoint } from "../memory/checkpoint.js";
import { describeRun, threadOf, type RunRecord } from "../run/record.js";
import type { RunLedger } from "../run/ledger.js";
import type { ToolExecutor } from "../tool/executor.js";
import type { ToolContext, ToolDefinition, ToolEmittedEvent, ToolResult } from "../tool/framework.js";
import { toolResultMessage } from "../tool/result.js";
import type { FaultSeam, Logger, ThreadMessage } from "../types.js";
import type { TokenEstimator } from "../utils/tokens.js";
import { REQUEST_ATTEMPTS_TEXT, type ContextManager } from "./compression.js";
import { LOOP_NOTICE, LOOP_STOP_TEXT, detectLoop } from "./loop-detector.js";

/** What follows a response the output limit cut, in place of its calls. */
export const TRUNCATED_NOTICE =
  "[Notice from the agent runtime] Your previous reply was cut off by the output token limit, so none of its tool calls were executed. Reply again, more briefly.";

/** Static configuration for an {@link AgentRunner}. */
export interface RunnerOptions {
  /** Model turns before the unit fails. */
  readonly maxTurns: number;
}

/** What the runner uses of the rest of the engine. */
export interface RunnerDeps {
  readonly model: ChatModel;
  readonly executor: ToolExecutor;
  /** Builds each request under the context budget. */
  readonly context: ContextManager;
  readonly estimator: TokenEstimator;
  readonly checkpoint: Checkpoint;
  readonly approvals: DurableApprovalLedger;
  readonly ledger: RunLedger;
  readonly log: Logger;
  readonly faults: FaultSeam;
  /** Keys (`callKey`) of the calls executing in this process right now; their intents are not interrupted calls. */
  readonly executing: Set<string>;
  /** Write an outbound event emitted by a tool. */
  readonly emit: (event: ToolEmittedEvent) => void;
}

/** One unit of work as the runner sees it. */
export interface UnitRun {
  readonly record: RunRecord;
  readonly config: DotRuntimeConfig;
  /** The tools offered with this config. */
  readonly tools: readonly ToolDefinition[];
  /** Built again for every request, because identities and memory keys change. */
  systemPrompt(): string;
  /** Aborts the unit: a model request in flight at once, and the unit before its next call. */
  readonly signal: AbortSignal;
  /**
   * Aborts a tool in flight. On a cancel it fires with `signal`; on a sleep
   * or a shutdown it fires only once the stop grace is over, so a running
   * call gets the time to finish and record its result.
   */
  readonly toolSignal: AbortSignal;
  onState(state: AgentState): void;
}

export type RunOutcome =
  | { readonly status: "completed"; readonly output: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "suspended" };

type CallOutcome = "answered" | "suspended";

/**
 * Drives one unit: model requests, tool execution, and looping.
 *
 * @example
 * ```ts
 * const runner = new AgentRunner(deps, { maxTurns: 60 })
 * const outcome = await runner.run(unit)
 * ```
 */
export class AgentRunner {
  constructor(
    private readonly deps: RunnerDeps,
    private readonly options: RunnerOptions,
  ) {}

  /**
   * Run the unit until the model answers without tool calls, a call waits
   * for the person, or the unit fails. An abort of `unit.signal` throws a
   * `UnitAbort`; everything committed so far stays.
   */
  async run(unit: UnitRun): Promise<RunOutcome> {
    const thread = threadOf(unit.record);
    let costUnknownLogged = false;

    for (;;) {
      throwIfAborted(unit.signal);
      const stored = this.deps.checkpoint.recent(thread, THREAD_READ_LIMIT);

      // Executing tools: the newest assistant message has calls without a result.
      const open = openCalls(stored);
      if (open) {
        const outcome = await this.executeRound(unit, stored, open.messageId, open.calls);
        if (outcome === "suspended") return { status: "suspended" };
        continue;
      }

      // Guard against unbounded loops.
      const turns = this.deps.ledger.steps(unit.record);
      if (turns >= this.options.maxTurns) {
        this.deps.log.warn("step limit reached", { ...describeRun(unit.record), steps: turns });
        return {
          status: "failed",
          error: `stopped after ${turns} model turns without a final answer (limits.max_steps_per_task is ${this.options.maxTurns})`,
        };
      }

      // The same calls returning the same results: told once, then stopped.
      const loop = detectLoop(stored.filter((m) => m.id >= unit.record.startMessageId).map((m) => m.message));
      if (loop === "stop") {
        this.deps.log.warn("loop detected", describeRun(unit.record));
        return { status: "failed", error: LOOP_STOP_TEXT };
      }
      if (loop === "notice") this.deps.checkpoint.notice(unit.record, LOOP_NOTICE);

      // The unit's spend, as persisted with every response.
      const capReached = this.deps.ledger.costCapReached(unit.record, unit.config.limits.max_cost_per_task_usd);
      if (capReached) return { status: "failed", error: capReached };

      unit.onState("THINKING");
      // One transaction before the step's requests (a flush, a summary, the
      // step itself): a step whose responses kill the process before their
      // commit is attempted at most three times.
      if (!this.deps.ledger.beginRequest()) return { status: "failed", error: REQUEST_ATTEMPTS_TEXT };
      const started = Date.now();
      let request: Awaited<ReturnType<ContextManager["prepare"]>>;
      let result: Awaited<ReturnType<ChatModel["chat"]>>;
      try {
        // Under the ceiling, or the unit fails here (a summary may be made first).
        request = await this.deps.context.prepare(unit);
        result = await this.deps.model.chat(
          { model: unit.config.model.id, messages: request.messages, ...(request.tools ? { tools: request.tools } : {}) },
          { signal: unit.signal },
        );
        throwIfAborted(unit.signal);
      } catch (error) {
        // A request the agent abandoned on purpose was not a failed attempt.
        if (error instanceof UnitAbort || unit.signal.aborted) this.deps.ledger.abandonRequest();
        throw error;
      }
      this.deps.faults.at("model:answered");
      if (result.usage.cost === undefined && !costUnknownLogged) {
        costUnknownLogged = true;
        this.deps.log.warn("the model reported no cost: the cost cap cannot hold this unit, the step limit still does", describeRun(unit.record));
      }
      this.deps.estimator.calibrate(unit.config.model.id, request.messages, request.tools, result.usage.prompt_tokens);
      this.deps.log.info("model answered", {
        ...describeRun(unit.record),
        model: result.model,
        tool_calls: result.toolCalls.length,
        prompt_tokens: result.usage.prompt_tokens,
        estimate: request.estimate,
        completion_tokens: result.usage.completion_tokens,
        cost: result.usage.cost,
        attempts: result.attempts,
        duration_ms: Date.now() - started,
      });

      unit.onState("PLANNING");
      // A response cut by the output limit may carry truncated arguments: none of its calls runs.
      if (result.finishReason === "length" && result.toolCalls.length > 0) {
        this.deps.log.warn("the response was cut by the output limit; its calls are not run", describeRun(unit.record));
        this.deps.checkpoint.assistant(unit.record, { role: "assistant", content: result.text }, result.usage, TRUNCATED_NOTICE);
        continue;
      }
      this.deps.checkpoint.assistant(unit.record, result.message, result.usage);

      if (result.toolCalls.length === 0) {
        return { status: "completed", output: result.text.trim() === "" ? "(no answer)" : result.text };
      }
    }
  }

  /**
   * Execute the open calls of the newest assistant message one at a time, in
   * the model's order. A call that waits for the person stops the round: the
   * calls after it wait for the decision too.
   */
  private async executeRound(
    unit: UnitRun,
    stored: readonly StoredMessage<ThreadMessage>[],
    messageId: number,
    calls: readonly OpenCall[],
  ): Promise<CallOutcome> {
    const assistantText = lastAssistantText(stored.map((m) => m.message));
    const thread = threadOf(unit.record);
    for (const open of calls) {
      const position: CallPosition = { messageId, callIndex: open.index };
      // A call whose intent survived the process that started it.
      const intent = this.deps.checkpoint.intentOf(thread, position);
      if (intent && !this.deps.executing.has(callKey(thread, messageId, open.index))) {
        const verdict = classifyIntent(intent);
        if (verdict !== "run again") {
          const approval = this.deps.approvals.forCall(thread, messageId, open.index);
          this.deps.log.warn("a call was interrupted by the last stop", { tool: intent.tool, attempts: intent.attempts, ...describeRun(unit.record) });
          this.deps.checkpoint.interrupted(unit.record, intent, interruptedText(verdict, approval?.status === "approved"));
          continue;
        }
        this.deps.log.info("running again a replay-safe call the last stop interrupted", { tool: intent.tool, ...describeRun(unit.record) });
      }
      const outcome = await this.executeToolCall(unit, position, open, assistantText);
      if (outcome === "suspended") return "suspended";
    }
    return "answered";
  }

  private async executeToolCall(unit: UnitRun, position: CallPosition, open: OpenCall, assistantText: string): Promise<CallOutcome> {
    const call = open.call;
    const parsed = parseToolCall(call);
    const verdict = decideTool(unit.config, unit.tools, parsed.name);
    const thread = threadOf(unit.record);
    let result: ToolResult;
    let durationMs = 0;
    if (verdict.decision === "deny") {
      result = { ok: false, text: `Denied by policy: ${verdict.reason}.` };
    } else if (parsed.arguments === null) {
      result = { ok: false, text: `Invalid arguments for ${parsed.name}: ${parsed.argumentsError}. Send a JSON object.` };
    } else {
      // The approval row is the record of the person's decision, keyed by the call's position.
      const approval = verdict.decision === "ask" ? this.deps.approvals.forCall(thread, position.messageId, position.callIndex) : undefined;
      if (verdict.decision === "ask" && !approval) {
        const reason = assistantText.trim() === "" ? verdict.reason : `${verdict.reason}. The agent said: ${assistantText.trim()}`;
        const taskId = unit.record.kind === "task" ? unit.record.taskId : null;
        const record = this.deps.approvals.request({
          thread,
          taskId,
          ...position,
          toolCallId: call.id,
          tool: parsed.name,
          permission: verdict.permission as Permission,
          arguments: parsed.arguments,
          reason,
        });
        this.deps.log.info("approval requested", { approval_id: record.approvalId, tool: parsed.name, task_id: taskId });
        unit.onState("WAITING_APPROVAL");
        return "suspended";
      }
      if (approval?.status === "pending") {
        unit.onState("WAITING_APPROVAL");
        return "suspended";
      }
      if (approval?.status === "rejected") {
        result = { ok: false, text: approval.note ? `Rejected by the user: ${approval.note}` : "Rejected by the user." };
      } else {
        ({ result, durationMs } = await this.execute(unit, parsed, position, verdict.permission, verdict.decision));
        // After the registry's cut, so a long result never loses the note.
        if (approval?.note) result = { ...result, text: `${result.text}\n(The user approved this call with a note: ${approval.note})` };
      }
    }

    const called: OutboundEventDataMap["tool.called"] = {
      ...(unit.record.kind === "task" ? { task_id: unit.record.taskId } : {}),
      tool: parsed.name,
      permission: verdict.permission,
      decision: verdict.decision as PolicyDecision,
      ok: result.ok,
      duration_ms: durationMs,
    };
    this.deps.checkpoint.toolResult(unit.record, position, toolResultMessage(call.id, result), called);
    return "answered";
  }

  /**
   * The side effect: the last abort check, Transaction A, the call. Its result
   * is committed by the caller whatever happened to the unit meanwhile; the
   * abort is looked at again only before the next call.
   */
  private async execute(
    unit: UnitRun,
    call: ParsedToolCall,
    position: CallPosition,
    permission: string,
    decision: string,
  ): Promise<{ result: ToolResult; durationMs: number }> {
    throwIfAborted(unit.signal);
    const thread = threadOf(unit.record);
    this.deps.checkpoint.intent(unit.record, position, { toolCallId: call.id, tool: call.name, permission, decision });
    this.deps.faults.at("intent:committed");
    unit.onState("EXECUTING");
    const context: ToolContext = {
      ...(unit.record.kind === "task" ? { taskId: unit.record.taskId } : {}),
      signal: unit.toolSignal,
      emit: this.deps.emit,
    };
    const key = callKey(thread, position.messageId, position.callIndex);
    this.deps.executing.add(key);
    try {
      const execution = await this.deps.executor.execute(call, context);
      this.deps.faults.at("tool:executed");
      // Cut at the stop grace: what the call did is unknown. Its intent stays,
      // and the next entry of the unit reports it (or runs it again, if replay-safe).
      if (unit.toolSignal.aborted && abortReason(unit.toolSignal) === "suspend") throw new UnitAbort("suspend");
      return execution;
    } finally {
      this.deps.executing.delete(key);
    }
  }
}

function lastAssistantText(messages: readonly ThreadMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") return m.content ?? "";
  }
  return "";
}
