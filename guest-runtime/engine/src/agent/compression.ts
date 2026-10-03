// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * The context budget is a ceiling (architecture section 8.6).
 *
 * The thread in `dot.db` stays whole and append-only; what changes is what a
 * request carries. A request is
 *
 *   system, [the unit's start message], [the newest summary], ...the thread after the summary
 *
 * and it is built in steps, each stopping once the estimate is at or under
 * the trigger (`TRIGGER` of `limits.context_tokens`):
 *
 *  1. consumed tool results become placeholders, the largest first (the
 *     oldest first among equals), never one below `MIN_PLACEHOLDER_TOKENS`
 *     and never in the newest round (the compression of consumed results
 *     this was derived from), and only the newest images are sent;
 *  2. a summary of the older part of the thread, after an optional
 *     memory-flush turn (the summary strategy this was derived from, with a
 *     cut at a legal point, the unit's start message pinned, the summary
 *     call in chunks and the stored summary capped);
 *  3. the largest results of the newest round are shrunk, head and tail;
 *  4. still above the ceiling: the unit fails. No request is ever sent
 *     above it, the flush and summary calls included.
 */
import { toFunctionTools, type ChatMessage, type ChatModel, type FunctionTool, type ParsedToolCall } from "@invisible-dots/openrouter-client";
import type { DotStore, StoredMessage } from "@invisible-dots/memory";
import { getTool, truncateText, type DotRuntimeConfig } from "@invisible-dots/shared";
import { decideTool } from "../dot/gate.js";
import { assertCallsAnswered, toRequestMessages } from "../dot/request.js";
import { ContextBudgetError, UnitAbort, throwIfAborted } from "../errors.js";
import type { RunLedger } from "../run/ledger.js";
import { describeRun, threadOf, type RunRecord } from "../run/record.js";
import type { ToolExecutor } from "../tool/executor.js";
import type { ToolDefinition, ToolEmittedEvent } from "../tool/framework.js";
import type { FaultSeam, Logger, StoredToolMessage, ThreadMessage } from "../types.js";
import type { TokenEstimator } from "../utils/tokens.js";

/** Building stops once a request is at or under this share of the budget. */
export const TRIGGER = 0.75;
/** No request above this share of the budget is ever sent. */
export const CEILING = 0.9;
/** The part kept verbatim after a summary fits in this share. */
const TAIL = 0.35;
/** One summary request carries at most this share of history. */
const CHUNK = 0.5;
/** A stored summary, memories included, is at most this share. */
const SUMMARY_CAP = 0.15;
/** A summary is forced once this many messages follow the newest one, so the read stays bounded. */
export const FORCED_SUMMARY_MESSAGES = 200;
/** Results of the newest round are never shrunk below this many characters. */
const MIN_SHRUNK_CHARS = 500;

/** Attempts a step may start; see `RunLedger.beginRequest`. */
export const REQUEST_ATTEMPTS_TEXT = "stopped: the model request failed to complete 3 times";

export const MEMORY_FLUSH_PROMPT =
  "[Context maintenance, not a new instruction from the user] Your working context is about to be compressed: " +
  "the older messages will be replaced by a short summary. Before that happens, call memory_remember once for every " +
  "fact you will still need to finish the task: exact codes, numbers, names, file paths, results, and what is done " +
  "and what is left. Use short stable keys. Call no other tool. If there is nothing to save, reply with the word nothing.";

export const SUMMARY_SYSTEM_PROMPT =
  "You compress the working history of an AI agent so it can continue its task with a smaller context. " +
  "Write a factual summary in plain text, at most 250 words: what the task is, which tool calls were made " +
  "(name and arguments) and what each returned that matters, every exact value the agent may still need " +
  "(codes, numbers, names, file paths) copied verbatim, what is done and what remains. " +
  "Do not invent anything, do not give instructions, do not call tools.";

/** What a consumed tool result is replaced with. */
export function placeholderText(tool: string, chars: number): string {
  return `[Tool result of ${tool}: ${chars} characters, already processed]`;
}

/**
 * A consumed result smaller than this is never replaced by a placeholder: it
 * costs little, and a short result is often exactly the value a later step
 * needs (a code, a name, a number looked up at the start of a task).
 */
export const MIN_PLACEHOLDER_TOKENS = 1_000;

/**
 * Tool results the model has already processed (an assistant message follows
 * them), oldest first, with the name of the tool that produced each. The
 * newest round is never among them: the model is about to see it.
 */
export function consumedResults(messages: readonly StoredMessage<ThreadMessage>[]): { id: number; tool: string }[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.message.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const names = new Map<string, string>();
  const out: { id: number; tool: string }[] = [];
  messages.forEach((stored, index) => {
    const m = stored.message;
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
    if (m.role === "tool" && index < lastAssistant) out.push({ id: stored.id, tool: names.get(m.tool_call_id) ?? "a tool" });
  });
  return out;
}

/**
 * The consumed results step 1 may replace, in the order it replaces them:
 * the largest first, so each placeholder saves the most, and the oldest
 * first among equals; never one below `MIN_PLACEHOLDER_TOKENS`.
 */
export function placeholderCandidates(
  messages: readonly StoredMessage<ThreadMessage>[],
  tokensOf: (text: string) => number,
): { id: number; tool: string; chars: number }[] {
  return consumedResults(messages)
    .map((result, order) => {
      const content = (messages.find((m) => m.id === result.id)!.message as StoredToolMessage).content;
      return { ...result, chars: content.length, tokens: tokensOf(content), order };
    })
    .filter((result) => result.tokens >= MIN_PLACEHOLDER_TOKENS)
    .sort((a, b) => b.tokens - a.tokens || a.order - b.order)
    .map(({ id, tool, chars }) => ({ id, tool, chars }));
}

/**
 * Move a cut index so it is legal: never past the newest assistant message
 * (the model must still see where it is), and never on a tool result (moving
 * forward drops that result's assistant message and all its results together).
 */
export function alignCut(tail: readonly ThreadMessage[], index: number): number {
  let lastAssistant = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  let cut = Math.max(0, Math.min(index, lastAssistant < 0 ? 0 : lastAssistant));
  while (cut < tail.length && tail[cut]!.role === "tool") cut++;
  return cut;
}

/** The smallest legal cut whose kept part fits in `keepTokens`. 0 means nothing can be summarized. */
export function chooseCut(tail: readonly ThreadMessage[], keepTokens: number, tokensOf: (m: ThreadMessage) => number): number {
  let kept = 0;
  let cut = tail.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    kept += tokensOf(tail[i]!);
    if (kept > keepTokens) break;
    cut = i;
  }
  return alignCut(tail, cut);
}

/** History as plain text for the summarizer: no tool roles, so its request has no pairs to break. */
export function transcript(messages: readonly ThreadMessage[], maxResultChars: number): string {
  const names = new Map<string, string>();
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.content && m.content.trim() !== "") lines.push(`ASSISTANT: ${m.content.trim()}`);
      for (const c of m.tool_calls ?? []) {
        names.set(c.id, c.function.name);
        lines.push(`ASSISTANT CALLED ${c.function.name}(${c.function.arguments})`);
      }
    } else if (m.role === "tool") {
      lines.push(`RESULT OF ${names.get(m.tool_call_id) ?? "tool"}: ${truncateText(m.content, maxResultChars, "head-tail")}`);
    } else if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
      lines.push(`USER: ${text}`);
    }
  }
  return lines.join("\n");
}

/** When the summarizer fails or cannot be asked: the calls and the head of each result. */
export function mechanicalSummary(messages: readonly ThreadMessage[]): string {
  return `(automatic digest, the summarizer did not answer)\n${transcript(messages, 200)}`;
}

function summaryRequestText(task: string, previous: string | undefined, history: string): string {
  return [
    `Task of the agent:\n${task || "(see history)"}`,
    previous ? `Summary of even earlier work (already compressed once):\n${previous}` : "",
    `History to compress, oldest first:\n${history}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The text of the summary message a request carries. */
export function summaryMessageText(summary: string, memories: readonly { key: string; content: string }[]): string {
  const parts = [
    "[Summary of the earlier messages of this thread, written when the context was compressed. The original messages are no longer shown.]",
    summary.trim(),
  ];
  if (memories.length > 0) {
    parts.push("Facts you saved to long-term memory before the compression:", ...memories.map((m) => `- ${m.key}: ${m.content}`));
  }
  return parts.join("\n");
}

/** The parts of a thread a request is built from. */
export interface ContextView {
  /** The unit's start message, when the summary covers it. */
  pinned: StoredMessage<ThreadMessage> | undefined;
  summary: { uptoMessageId: number; text: string; plain: string; memoryKeys: string[] } | undefined;
  /** The thread after the summary. */
  tail: StoredMessage<ThreadMessage>[];
}

export interface PreparedRequest {
  messages: ChatMessage[];
  tools: FunctionTool[] | undefined;
  estimate: number;
}

/** What one unit's request is built for. */
export interface ContextUnit {
  readonly record: RunRecord;
  readonly config: Pick<DotRuntimeConfig, "model" | "limits" | "memory" | "permissions">;
  readonly tools: readonly ToolDefinition[];
  systemPrompt(): string;
  readonly signal: AbortSignal;
}

export interface ContextDeps {
  readonly model: ChatModel;
  readonly store: DotStore;
  readonly ledger: RunLedger;
  readonly executor: ToolExecutor;
  readonly estimator: TokenEstimator;
  readonly log: Logger;
  readonly faults: FaultSeam;
  readonly emit: (event: ToolEmittedEvent) => void;
}

/** Builds every request of a unit under its budget, summarizing the thread when it must. */
export class ContextManager {
  constructor(private readonly deps: ContextDeps) {}

  /** The request of the next step, at or under the ceiling, or a `ContextBudgetError`. */
  async prepare(unit: ContextUnit): Promise<PreparedRequest> {
    const budget = unit.config.limits.context_tokens;
    const model = unit.config.model.id;
    const tools = unit.tools.length > 0 ? toFunctionTools(unit.tools) : undefined;
    const system = unit.systemPrompt();
    let view = this.view(unit.record, budget, model);
    let built = this.fit(view, system, tools, model, budget);
    if (built.request.estimate > budget * TRIGGER || view.tail.length > FORCED_SUMMARY_MESSAGES) {
      if (await this.compress(unit, view, built.request, budget)) {
        view = this.view(unit.record, budget, model);
        built = this.fit(view, system, tools, model, budget);
      }
    }
    let request = built.request;
    if (request.estimate > budget * TRIGGER) request = this.shrinkNewestRound(view, built.replaced, system, tools, model, budget);
    if (request.estimate > budget * CEILING) throw new ContextBudgetError(budget);
    return request;
  }

  /** The newest summary, the thread after it, and the start message when the summary covers it. */
  view(record: RunRecord, budget: number, model: string): ContextView {
    const thread = threadOf(record);
    const row = this.deps.store.latestSummary(thread);
    const tail = this.deps.store.listMessages<ThreadMessage>(thread, { afterId: row?.uptoMessageId ?? 0 });
    let pinned: StoredMessage<ThreadMessage> | undefined;
    if (row && record.startMessageId > 0 && record.startMessageId <= row.uptoMessageId) {
      pinned = this.deps.store.getMessage<ThreadMessage>(record.startMessageId);
    }
    const summary = row
      ? {
          uptoMessageId: row.uptoMessageId,
          plain: row.summary,
          memoryKeys: row.memoryKeys,
          // Capped as it is sent, memories included, so it can never alone fill the budget.
          text: truncateText(summaryMessageText(row.summary, this.memoriesOf(row.memoryKeys)), this.deps.estimator.charsFor(model, budget * SUMMARY_CAP)),
        }
      : undefined;
    return { pinned, summary, tail };
  }

  /** Step 1: placeholders for the largest consumed results, until the request is under the trigger. */
  private fit(view: ContextView, system: string, tools: FunctionTool[] | undefined, model: string, budget: number) {
    const replaced = new Map<number, ThreadMessage>();
    let request = this.assemble(view, replaced, system, tools, model);
    for (const result of placeholderCandidates(view.tail, (text) => this.deps.estimator.textTokens(model, text))) {
      if (request.estimate <= budget * TRIGGER) break;
      const stored = view.tail.find((m) => m.id === result.id)!.message as StoredToolMessage;
      replaced.set(result.id, { role: "tool", tool_call_id: stored.tool_call_id, content: placeholderText(result.tool, result.chars) });
      request = this.assemble(view, replaced, system, tools, model);
    }
    return { request, replaced };
  }

  /** Step 3: shrink the largest results of the newest round, head and tail, until under the trigger. */
  private shrinkNewestRound(
    view: ContextView,
    replaced: Map<number, ThreadMessage>,
    system: string,
    tools: FunctionTool[] | undefined,
    model: string,
    budget: number,
  ): PreparedRequest {
    let lastAssistant = -1;
    view.tail.forEach((m, i) => {
      if (m.message.role === "assistant") lastAssistant = i;
    });
    const round = view.tail.slice(lastAssistant + 1).filter((m) => m.message.role === "tool");
    let request = this.assemble(view, replaced, system, tools, model);
    for (;;) {
      if (request.estimate <= budget * TRIGGER) return request;
      const sizes = round.map((m) => ({ m, text: ((replaced.get(m.id) ?? m.message) as StoredToolMessage).content }));
      const largest = sizes.filter((s) => s.text.length > MIN_SHRUNK_CHARS).sort((a, b) => b.text.length - a.text.length)[0];
      if (!largest) return request;
      const message = largest.m.message as StoredToolMessage;
      const max = Math.max(MIN_SHRUNK_CHARS, Math.floor(largest.text.length / 2));
      replaced.set(largest.m.id, { ...message, content: truncateText(largest.text, max, "head-tail") });
      request = this.assemble(view, replaced, system, tools, model);
    }
  }

  private assemble(
    view: ContextView,
    replaced: ReadonlyMap<number, ThreadMessage>,
    system: string,
    tools: FunctionTool[] | undefined,
    model: string,
  ): PreparedRequest {
    const tail = view.tail.map((m) => replaced.get(m.id) ?? m.message);
    assertCallsAnswered(tail);
    const head: ThreadMessage[] = [];
    if (view.pinned) head.push(view.pinned.message);
    if (view.summary) head.push({ role: "user", content: view.summary.text });
    const messages: ChatMessage[] = [{ role: "system", content: system }, ...toRequestMessages([...head, ...tail])];
    return { messages, tools, estimate: this.deps.estimator.estimate(model, messages, tools) };
  }

  /**
   * Step 2: summarize the older part of the thread. Returns false when no
   * legal cut leaves anything to summarize.
   */
  private async compress(unit: ContextUnit, view: ContextView, current: PreparedRequest, budget: number): Promise<boolean> {
    const model = unit.config.model.id;
    const tail = view.tail.map((m) => m.message);
    const tokensOf = (m: ThreadMessage) => this.deps.estimator.textTokens(model, JSON.stringify(m));
    let cut = chooseCut(tail, budget * TAIL, tokensOf);
    if (tail.length > FORCED_SUMMARY_MESSAGES) cut = Math.max(cut, alignCut(tail, tail.length - FORCED_SUMMARY_MESSAGES / 2));
    if (cut <= 0) {
      this.deps.log.warn("context over the trigger but nothing can be summarized", { ...describeRun(unit.record), estimate: current.estimate });
      return false;
    }
    this.deps.log.info("compressing context", { ...describeRun(unit.record), estimate: current.estimate, budget, messages: cut });

    const saved = await this.flush(unit, current, budget);
    const old = view.tail.slice(0, cut);
    const start = view.pinned?.message ?? view.tail.find((m) => m.id === unit.record.startMessageId)?.message;
    const task = start && start.role === "user" && typeof start.content === "string" ? start.content : "";
    let summary = await this.summarize(unit, old.map((m) => m.message), task, view.summary?.plain, budget);
    summary = truncateText(summary, this.deps.estimator.charsFor(model, budget * SUMMARY_CAP));

    const memoryKeys = [...new Set([...(view.summary?.memoryKeys ?? []), ...saved])];
    const thread = threadOf(unit.record);
    this.deps.store.transaction(() => {
      this.deps.store.addSummary({ thread, uptoMessageId: old[old.length - 1]!.id, summary, memoryKeys });
      this.deps.ledger.resetRequests();
    });
    this.deps.faults.at("summary:committed");
    // The summary is kept: what follows is a new attempt of the step.
    if (!this.deps.ledger.beginRequest()) throw new Error(REQUEST_ATTEMPTS_TEXT);
    this.deps.log.info("context summarized", { ...describeRun(unit.record), upto_message_id: old[old.length - 1]!.id, summary_chars: summary.length });
    return true;
  }

  /**
   * The memory-flush turn: the model saves what it will still need, with the
   * memory tool, before the summary replaces the messages. Only when memory
   * is on, the policy allows `memory.write` outright, and the flush request
   * itself is under the ceiling. Returns the keys saved.
   */
  private async flush(unit: ContextUnit, current: PreparedRequest, budget: number): Promise<string[]> {
    if (!unit.config.memory.enabled) return [];
    const remember = unit.tools.find((t) => t.name === "memory_remember");
    if (!remember || decideTool(unit.config, unit.tools, remember.name).decision !== "allow") return [];
    const model = unit.config.model.id;
    const messages: ChatMessage[] = [...current.messages, { role: "user", content: MEMORY_FLUSH_PROMPT }];
    const tools = toFunctionTools([remember]);
    if (this.deps.estimator.estimate(model, messages, tools) > budget * CEILING) {
      this.deps.log.info("memory flush skipped: its own request would exceed the ceiling", describeRun(unit.record));
      return [];
    }
    const response = await this.request(unit, { model, messages, tools });
    if (response.finishReason === "length") return [];
    const saved: string[] = [];
    for (const call of response.toolCalls) {
      if (call.name !== "memory_remember" || call.arguments === null) continue;
      saved.push(...(await this.remember(unit, call)));
    }
    return saved;
  }

  /** One flush call, through the registry like any call, with its `tool.called`. */
  private async remember(unit: ContextUnit, call: ParsedToolCall): Promise<string[]> {
    const taskId = unit.record.kind === "task" ? unit.record.taskId : undefined;
    const { result, durationMs } = await this.deps.executor.execute(call, {
      ...(taskId ? { taskId } : {}),
      signal: unit.signal,
      emit: this.deps.emit,
    });
    this.deps.store.appendEvent("tool.called", {
      ...(taskId ? { task_id: taskId } : {}),
      tool: call.name,
      permission: getTool(call.name)?.permission ?? "",
      decision: "allow",
      ok: result.ok,
      duration_ms: durationMs,
    });
    const key = call.arguments?.key;
    return result.ok && typeof key === "string" ? [key] : [];
  }

  /**
   * The summary of `old`, by the unit's model, in requests of at most
   * `CHUNK` of the budget each; each chunk is summarized together with the
   * summary so far. A failed or cut answer falls back to a mechanical digest.
   */
  private async summarize(unit: ContextUnit, old: readonly ThreadMessage[], task: string, previous: string | undefined, budget: number): Promise<string> {
    const model = unit.config.model.id;
    const chunkChars = this.deps.estimator.charsFor(model, budget * CHUNK);
    const results = Math.max(1, old.filter((m) => m.role === "tool").length);
    const history = transcript(old, Math.max(500, Math.floor(chunkChars / results)));
    let summary = previous;
    for (let at = 0; at < history.length; at += chunkChars) {
      const chunk = history.slice(at, at + chunkChars);
      const messages: ChatMessage[] = [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: summaryRequestText(truncateText(task, chunkChars / 4), summary, chunk) },
      ];
      if (this.deps.estimator.estimate(model, messages) > budget * CEILING) return mechanicalSummary(old);
      try {
        const response = await this.request(unit, { model, messages });
        this.deps.faults.at("summary:answered");
        summary = response.finishReason === "length" || response.text.trim() === "" ? mechanicalSummary(old) : response.text.trim();
      } catch (error) {
        if (error instanceof UnitAbort || unit.signal.aborted) throw error;
        this.deps.log.warn("the summarizer failed; using a mechanical digest", { error: error instanceof Error ? error.message : String(error) });
        return mechanicalSummary(old);
      }
    }
    return summary ?? mechanicalSummary(old);
  }

  /** A model request that is not a step (part of the step's attempt): its usage counts toward cost, not steps. */
  private async request(unit: ContextUnit, request: Parameters<ChatModel["chat"]>[0]) {
    const capReached = this.deps.ledger.costCapReached(unit.record, unit.config.limits.max_cost_per_task_usd);
    if (capReached) throw new Error(capReached);
    const response = await this.deps.model.chat(request, { signal: unit.signal });
    throwIfAborted(unit.signal);
    this.deps.ledger.addUsage(unit.record, response.usage);
    return response;
  }

  private memoriesOf(keys: readonly string[]): { key: string; content: string }[] {
    return keys.flatMap((key) => {
      const m = this.deps.store.getMemory(key);
      return m ? [{ key, content: m.content }] : [];
    });
  }
}
