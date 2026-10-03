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
import {
  OpenRouterError,
  parseToolCall,
  toFunctionTools,
  type ChatMessage,
  type ChatModel,
  type ParsedToolCall,
  type Usage,
} from "@invisible-dots/openrouter-client";
import type { StoredMessage } from "@invisible-dots/memory";
import type { AgentState, DotRuntimeConfig, OutboundEventDataMap, Permission, PolicyDecision } from "@invisible-dots/shared";
import type { DurableApprovalLedger } from "../approval/durable.js";
import { decideTool } from "../dot/gate.js";
import { callKey, classifyIntent, interruptedText } from "../dot/intents.js";
import { THREAD_READ_LIMIT, assertCallsAnswered, openCalls, type OpenCall } from "../dot/request.js";
import { UnitAbort, throwIfAborted } from "../errors.js";
import type { CallPosition, Checkpoint } from "../memory/checkpoint.js";
import { describeRun, threadOf, type RunRecord } from "../run/record.js";
import type { RunLedger } from "../run/ledger.js";
import type { ToolExecutor } from "../tool/executor.js";
import type { ToolContext, ToolDefinition, ToolEmittedEvent, ToolResult } from "../tool/framework.js";
import { toolResultMessage } from "../tool/result.js";
import type { FaultSeam, Logger, LoopDetectionConfig, ThreadMessage } from "../types.js";
import { estimateTokens } from "../utils/tokens.js";
import { LoopDetector, loopWarningText } from "./loop-detector.js";

/** Default minimum content length before tool result compression kicks in. */
const DEFAULT_MIN_COMPRESS_CHARS = 500;

/** Static configuration for an {@link AgentRunner}. */
export interface RunnerOptions {
  /** Model turns before the unit fails. */
  readonly maxTurns: number;
  /** Loop detection configuration. When set, detects stuck agent loops. */
  readonly loopDetection?: LoopDetectionConfig;
  /** Replace tool results the model has already processed with a short marker. */
  readonly compressToolResults?: boolean | { readonly minChars?: number };
  /** Summarize older messages once the request would exceed `maxTokens`. */
  readonly contextStrategy?: { readonly maxTokens: number; readonly summaryModel?: string };
}

/** What the runner uses of the rest of the engine. */
export interface RunnerDeps {
  readonly model: ChatModel;
  readonly executor: ToolExecutor;
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
  /** Turn the thread into the request messages that follow the system prompt. */
  requestMessages(thread: readonly ThreadMessage[]): ChatMessage[];
  readonly signal: AbortSignal;
  onState(state: AgentState): void;
}

export type RunOutcome =
  | { readonly status: "completed"; readonly output: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "suspended" };

type CallOutcome = "answered" | "suspended";

/** Model requests a step may start; see `RunLedger.beginRequest`. */
const REQUEST_ATTEMPTS_TEXT = "stopped: the model request failed to complete 3 times";

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
  private summarizeCache: { oldSignature: string; summaryPrefix: string } | null = null;

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
    const detector = this.options.loopDetection ? new LoopDetector(this.options.loopDetection) : null;
    let loopWarned = false;
    let pendingWarning: string | undefined;

    for (;;) {
      throwIfAborted(unit.signal);
      const stored = this.deps.checkpoint.recent(thread, THREAD_READ_LIMIT);
      const recent = stored.map((m) => m.message);

      // Executing tools: the newest assistant message has calls without a result.
      const open = openCalls(stored);
      if (open) {
        const outcome = await this.executeRound(unit, stored, open.messageId, open.calls);
        if (outcome === "suspended") return { status: "suspended" };
        if (pendingWarning !== undefined) {
          this.deps.checkpoint.notice(unit.record, pendingWarning);
          pendingWarning = undefined;
        }
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

      unit.onState("THINKING");
      let history: readonly ThreadMessage[] = recent;
      // Compress consumed tool results before the context strategy (no model call).
      if (this.options.compressToolResults) history = this.compressConsumedToolResults(history);
      if (this.options.contextStrategy) history = await this.summarizeMessages(history, unit);
      const requestThread = unit.requestMessages(history);
      assertCallsAnswered(history);

      // One transaction before the request: a response whose commit kills the
      // process is paid for at most three times.
      if (!this.deps.ledger.beginRequest()) return { status: "failed", error: REQUEST_ATTEMPTS_TEXT };
      const started = Date.now();
      let result: Awaited<ReturnType<ChatModel["chat"]>>;
      try {
        result = await this.deps.model.chat(
          {
            model: unit.config.model.id,
            messages: [{ role: "system", content: unit.systemPrompt() }, ...requestThread],
            ...(unit.tools.length > 0 ? { tools: toFunctionTools(unit.tools) } : {}),
          },
          { signal: unit.signal },
        );
        throwIfAborted(unit.signal);
      } catch (error) {
        // A request the agent abandoned on purpose was not a failed attempt.
        if (error instanceof UnitAbort || unit.signal.aborted) this.deps.ledger.abandonRequest();
        throw error;
      }
      this.deps.faults.at("model:answered");
      this.deps.log.info("model answered", {
        ...describeRun(unit.record),
        model: result.model,
        tool_calls: result.toolCalls.length,
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        cost: result.usage.cost,
        attempts: result.attempts,
        duration_ms: Date.now() - started,
      });

      unit.onState("PLANNING");
      this.deps.checkpoint.assistant(unit.record, result.message, result.usage);

      // Loop detection, before any tool runs, so that a stop never leaves a
      // call without its result.
      if (detector) {
        const toolInfo = result.toolCalls.length > 0 ? detector.recordToolCalls(result.toolCalls.map((c) => ({ name: c.name, input: c.arguments }))) : null;
        const textInfo = result.text.length > 0 ? detector.recordText(result.text) : null;
        const info = toolInfo ?? textInfo;
        if (info) {
          if (loopWarned) return { status: "failed", error: info.detail };
          loopWarned = true;
          pendingWarning = loopWarningText(info.kind);
        } else {
          // The agent has recovered: a future loop gets a fresh warning.
          loopWarned = false;
        }
      }

      if (result.toolCalls.length === 0) {
        if (pendingWarning !== undefined) {
          this.deps.checkpoint.notice(unit.record, pendingWarning);
          pendingWarning = undefined;
          continue;
        }
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
      signal: unit.signal,
      emit: this.deps.emit,
    };
    const key = callKey(thread, position.messageId, position.callIndex);
    this.deps.executing.add(key);
    try {
      const execution = await this.deps.executor.execute(call, context);
      this.deps.faults.at("tool:executed");
      return execution;
    } finally {
      this.deps.executing.delete(key);
    }
  }

  /**
   * Replace consumed tool results with compact markers.
   *
   * A tool result is "consumed" when the assistant has produced a response
   * after seeing it. The newest results are always kept intact: the model is
   * about to see them. Error results and results shorter than `minChars` are
   * never compressed.
   */
  private compressConsumedToolResults(messages: readonly ThreadMessage[]): ThreadMessage[] {
    const config = this.options.compressToolResults;
    const minChars = typeof config === "object" ? (config.minChars ?? DEFAULT_MIN_COMPRESS_CHARS) : DEFAULT_MIN_COMPRESS_CHARS;
    let lastAssistant = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") {
        lastAssistant = i;
        break;
      }
    }
    return messages.map((message, index) => {
      if (message.role !== "tool" || index > lastAssistant) return message;
      if (message.content.startsWith("Error:") || message.content.startsWith("[Tool output compressed")) return message;
      if (message.content.length < minChars) return message;
      return { ...message, content: `[Tool output compressed: ${message.content.length} chars, already processed]` };
    });
  }

  /**
   * Summarize the older part of the history once it exceeds the strategy's
   * token threshold. The first user message is kept as it is, and the cut
   * never separates tool results from the assistant message that asked for them.
   */
  private async summarizeMessages(messages: readonly ThreadMessage[], unit: UnitRun): Promise<readonly ThreadMessage[]> {
    const strategy = this.options.contextStrategy!;
    if (estimateTokens(messages) <= strategy.maxTokens || messages.length < 4) return messages;
    const firstUserIndex = messages.findIndex((m) => m.role === "user");
    if (firstUserIndex < 0 || firstUserIndex === messages.length - 1) return messages;
    const firstUser = messages[firstUserIndex]!;
    const rest = messages.slice(firstUserIndex + 1);
    let splitAt = Math.max(2, Math.floor(rest.length / 4) * 2);
    while (splitAt < rest.length && rest[splitAt]!.role === "tool") splitAt++;
    if (splitAt >= rest.length) return messages;
    const oldPortion = rest.slice(0, splitAt);
    const recentPortion = rest.slice(splitAt);

    const oldSignature = oldPortion.map((m) => JSON.stringify(m)).join("\n");
    let summaryPrefix: string;
    if (this.summarizeCache !== null && this.summarizeCache.oldSignature === oldSignature) {
      summaryPrefix = this.summarizeCache.summaryPrefix;
    } else {
      const summaryPrompt = [
        "Summarize the following conversation history for an LLM.",
        "- Preserve user goals, constraints, and decisions.",
        "- Keep key tool outputs and unresolved questions.",
        "- Use concise bullets.",
        "- Do not fabricate details.",
      ].join("\n");
      let usage: Usage | undefined;
      try {
        const response = await this.deps.model.chat(
          {
            model: strategy.summaryModel ?? unit.config.model.id,
            messages: [{ role: "user", content: `${summaryPrompt}\n\nConversation:\n${oldSignature}` }],
          },
          { signal: unit.signal },
        );
        usage = response.usage;
        const summaryText = response.text.trim();
        summaryPrefix = summaryText.length > 0 ? `[Conversation summary]\n${summaryText}` : "[Conversation summary unavailable]";
      } catch (error) {
        if (!(error instanceof OpenRouterError) || error.code === "aborted") throw error;
        summaryPrefix = "[Conversation summary unavailable]";
      }
      this.deps.log.info("conversation summarized", { ...describeRun(unit.record), prompt_tokens: usage?.prompt_tokens });
      this.summarizeCache = { oldSignature, summaryPrefix };
    }
    return [firstUser, { role: "user", content: summaryPrefix }, ...recentPortion];
  }
}

function lastAssistantText(messages: readonly ThreadMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") return m.content ?? "";
  }
  return "";
}
