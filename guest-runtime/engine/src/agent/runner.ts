// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * @fileoverview Core conversation loop engine for open-multi-agent.
 *
 * {@link AgentRunner} is the heart of the framework. It handles:
 *  - Sending messages to the LLM adapter
 *  - Extracting tool-use blocks from the response
 *  - Executing tool calls in parallel via {@link ToolExecutor}
 *  - Appending tool results and looping back until `end_turn`
 *  - Accumulating token usage and timing data across all turns
 *
 * The loop follows a standard agentic conversation pattern:
 * one outer `while (true)` that breaks on `end_turn` or maxTurns exhaustion.
 */

import type {
  LLMMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolCallRecord,
  TokenUsage,
  ToolResult,
  ToolUseContext,
  LLMAdapter,
  LLMChatOptions,
  LLMResponse,
  LoopDetectionConfig,
  LLMToolDef,
  ContextStrategy,
  ToolCallGate,
  InFlightTaskCheckpoint,
  PendingToolCallCheckpoint,
  ToolCallCommitCheckpoint,
  ApprovalDecisionRecord,
  ApprovalRequest,
  ToolCallApprovalContent,
} from '../types.js'
import { LLMCallTimeoutError, TokenBudgetExceededError } from '../errors.js'
import { LoopDetector } from './loop-detector.js'
import { mergeAbortSignals } from '../utils/abort.js'
import { estimateTokens } from '../utils/tokens.js'
import type { ToolRegistry } from '../tool/framework.js'
import type { ToolExecutor } from '../tool/executor.js'
import { createApprovalRequest, DurableApprovalError } from '../approval/durable.js'
import {
  copyToolResultContent,
  modelOutputFromToolResult,
  summarizeToolResultContent,
  toolResultContentSize,
} from '../tool/result.js'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Static configuration for an {@link AgentRunner} instance.
 * These values are constant across every `run` / `stream` call.
 */
export interface RunnerOptions {
  /** LLM model identifier, e.g. `'claude-opus-4-6'`. */
  readonly model: string
  /** Optional system prompt prepended to every conversation. */
  readonly systemPrompt?: string
  /**
   * Maximum number of tool-call round-trips before the runner stops.
   * Prevents unbounded loops. Defaults to `10`.
   */
  readonly maxTurns?: number
  /** Maximum output tokens per LLM response. */
  readonly maxTokens?: number
  /** Sampling temperature passed to the adapter. */
  readonly temperature?: number
  /** AbortSignal that cancels any in-flight adapter call and stops the loop. */
  readonly abortSignal?: AbortSignal
  /** See {@link AgentConfig.callTimeoutMs}. Per single `adapter.chat()` call. */
  readonly callTimeoutMs?: number
  /** Optional per-call tool gate inherited from agent or orchestrator config. */
  readonly onToolCall?: ToolCallGate
  /** Display name of the agent driving this runner (used in tool context). */
  readonly agentName?: string
  /** Short role description of the agent (used in tool context). */
  readonly agentRole?: string
  /** Loop detection configuration. When set, detects stuck agent loops. */
  readonly loopDetection?: LoopDetectionConfig
  /** Maximum cumulative tokens (input + output) allowed for this run. */
  readonly maxTokenBudget?: number
  /** Optional context compression strategy for long multi-turn runs. */
  readonly contextStrategy?: ContextStrategy
  /**
   * Compress tool results that the agent has already processed.
   * See {@link AgentConfig.compressToolResults} for details.
   */
  readonly compressToolResults?: boolean | { readonly minChars?: number }
}

/**
 * Per-call callbacks for observing tool execution in real time.
 * All callbacks are optional; unused ones are simply skipped.
 */
export interface RunOptions {
  /** Fired just before each tool is dispatched. */
  readonly onToolCall?: (name: string, input: Record<string, unknown>) => void
  /** Fired after each tool result is received. */
  readonly onToolResult?: (name: string, result: ToolResult<any>) => void
  /** Fired after each complete {@link LLMMessage} is appended. */
  readonly onMessage?: (message: LLMMessage) => void
  /**
   * Internal checkpoint state supplied by the orchestrator when resuming an
   * interrupted task. Custom backends may ignore it.
   */
  readonly resumeState?: InFlightTaskCheckpoint
  /**
   * Internal durable-boundary callback. The runner awaits it before crossing a
   * recoverable message/tool boundary; failures must be isolated by the caller.
   */
  readonly onCheckpoint?: (state: InFlightTaskCheckpoint) => void | Promise<void>
  /** Internal primary-ledger write after the pending runner state is durable. */
  readonly onApprovalRequest?: (request: ApprovalRequest) => void | Promise<void>
  /** Internal fail-fast check run before a pending approval enters the checkpoint. */
  readonly onApprovalPrepare?: () => void | Promise<void>
  /** Internal notification used to remove a reviewed request after commit. */
  readonly onApprovalConsumed?: (requestId: string) => void | Promise<void>
  /**
   * Fired when the runner detects a potential configuration issue.
   * For example, when a model appears to ignore tool definitions.
   */
  readonly onWarning?: (message: string) => void
  /** Run ID, used to name durable approval requests. */
  readonly runId?: string
  /** Task ID, used to name durable approval requests. */
  readonly taskId?: string
  /**
   * Per-call abort signal. When set, takes precedence over the static
   * {@link RunnerOptions.abortSignal}. Useful for per-run timeouts.
   */
  readonly abortSignal?: AbortSignal
}

/** The aggregated result returned when a full run completes. */
export interface RunResult {
  /** All messages accumulated during this run (assistant + tool results). */
  readonly messages: LLMMessage[]
  /** The final text output from the last assistant turn. */
  readonly output: string
  /** All tool calls made during this run, in execution order. */
  readonly toolCalls: ToolCallRecord[]
  /** Aggregated token counts across every LLM call in this run. */
  readonly tokenUsage: TokenUsage
  /** Total number of LLM turns (including tool-call follow-ups). */
  readonly turns: number
  /** True when the run was terminated or warned due to loop detection. */
  readonly loopDetected?: boolean
  /** True when the run was terminated due to token budget limits. */
  readonly budgetExceeded?: boolean
  /** True when the runner stopped before its next LLM call because the signal was aborted. */
  readonly aborted?: boolean
  /** True when one or more tool invocations await durable approval. */
  readonly suspended?: boolean
  /** Exact requests that stopped this runner before tool execution. */
  readonly pendingApprovals?: readonly ApprovalRequest[]
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract every TextBlock from a content array and join them. */
function extractText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

/** Extract every ToolUseBlock from a content array. */
function extractToolUseBlocks(content: readonly ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
}

/** Add two {@link TokenUsage} values together, returning a new object. */
function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }

/** Default minimum content length before tool result compression kicks in. */
const DEFAULT_MIN_COMPRESS_CHARS = 500

/**
 * Prepends synthetic framing text to the first user message so we never emit
 * consecutive `user` turns (Bedrock) and summaries do not concatenate onto
 * the original user prompt (direct API). If there is no user message yet,
 * inserts a single assistant text preamble.
 */
function prependSyntheticPrefixToFirstUser(
  messages: LLMMessage[],
  prefix: string,
): LLMMessage[] {
  const userIdx = messages.findIndex(m => m.role === 'user')
  if (userIdx < 0) {
    const preamble: TextBlock = { type: 'text', text: prefix.trimEnd() }
    return [{ role: 'assistant', content: [preamble] }, ...messages]
  }
  const target = messages[userIdx]!
  const prefixBlock: TextBlock = { type: 'text', text: prefix }
  const merged: LLMMessage = {
    role: 'user',
    content: [prefixBlock, ...target.content],
  }
  return [...messages.slice(0, userIdx), merged, ...messages.slice(userIdx + 1)]
}

function loopWarningText(kind: 'tool_repetition' | 'text_repetition'): string {
  return kind === 'text_repetition'
    ? 'WARNING: You appear to be generating the same response repeatedly. ' +
        'This suggests you are stuck in a loop. Please try a different approach ' +
        'or provide new information.'
    : 'WARNING: You appear to be repeating the same tool calls with identical arguments. ' +
        'This suggests you are stuck in a loop. Please try a different approach, use different ' +
        'parameters, or explain what you are trying to accomplish.'
}

interface ToolExecution {
  readonly commit: ToolCallCommitCheckpoint
  /** Original result for callbacks; absent when replaying a persisted commit. */
  readonly result?: ToolResult
  /** False only when cancellation interrupted the call before a durable result. */
  readonly shouldCommit: boolean
  /** Present only when the gate requested a durable suspension. */
  readonly suspension?: {
    readonly content: ToolCallApprovalContent
    readonly reason?: string
  }
  /** Filled after the pending runner state and primary record are durable. */
  readonly approvalRequest?: ApprovalRequest
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/**
 * Drives a full agentic conversation: LLM calls, tool execution, and looping.
 *
 * @example
 * ```ts
 * const runner = new AgentRunner(adapter, registry, executor, {
 *   model: 'claude-opus-4-6',
 *   maxTurns: 10,
 * })
 * const result = await runner.run(messages)
 * console.log(result.output)
 * ```
 */
export class AgentRunner {
  private readonly maxTurns: number
  private summarizeCache: {
    oldSignature: string
    summaryPrefix: string
  } | null = null

  constructor(
    private readonly adapter: LLMAdapter,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: ToolExecutor,
    private readonly options: RunnerOptions,
  ) {
    this.maxTurns = options.maxTurns ?? 10
  }

  private serializeMessage(message: LLMMessage): string {
    return JSON.stringify(message)
  }

  /**
   * Send one `adapter.chat()` request bounded by an OMA-owned per-call timeout.
   *
   * When {@link RunnerOptions.callTimeoutMs} is set, a fresh
   * `AbortSignal.timeout()` is minted for THIS call and merged with any signal
   * already on `options`, so the per-call bound and the whole-run bound
   * ({@link RunnerOptions.abortSignal}) compose — whichever fires first wins.
   * A fresh signal per call is essential: baking one `AbortSignal.timeout()`
   * into the shared chat options would degrade it into a whole-run deadline.
   *
   * If our per-call deadline fires (and the caller's own signal did not), the
   * provider's abort rejection is translated into an {@link LLMCallTimeoutError}
   * so a stalled provider is observable and distinguishable from a deliberate
   * cancellation. Applied uniformly to every model call the runner owns (the
   * main agentic loop and summarize-based context compaction), so behavior no
   * longer depends on each vendor SDK's default request timeout.
   */
  private async chatWithCallTimeout(
    messages: LLMMessage[],
    options: LLMChatOptions,
  ): Promise<LLMResponse> {
    const timeoutMs = this.options.callTimeoutMs
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return this.adapter.chat(messages, options)
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const base = options.abortSignal
    const abortSignal = base ? mergeAbortSignals(base, timeoutSignal) : timeoutSignal
    try {
      return await this.adapter.chat(messages, { ...options, abortSignal })
    } catch (err) {
      // Only claim a per-call timeout when our deadline fired and the caller's
      // own signal did not — otherwise surface the original abort/error as-is.
      if (timeoutSignal.aborted && base?.aborted !== true) {
        throw new LLMCallTimeoutError(timeoutMs, this.options.agentName)
      }
      throw err
    }
  }

  private async summarizeMessages(
    messages: LLMMessage[],
    maxTokens: number,
    summaryModel: string | undefined,
    baseChatOptions: LLMChatOptions,
  ): Promise<{ messages: LLMMessage[]; usage: TokenUsage }> {
    const estimated = estimateTokens(messages)
    if (estimated <= maxTokens || messages.length < 4) {
      return { messages, usage: ZERO_USAGE }
    }

    const firstUserIndex = messages.findIndex(m => m.role === 'user')
    if (firstUserIndex < 0 || firstUserIndex === messages.length - 1) {
      return { messages, usage: ZERO_USAGE }
    }

    const firstUser = messages[firstUserIndex]!
    const rest = messages.slice(firstUserIndex + 1)
    if (rest.length < 2) {
      return { messages, usage: ZERO_USAGE }
    }

    // Split on an even boundary so we never separate a tool_use assistant turn
    // from its tool_result user message (rest is user/assistant pairs).
    const splitAt = Math.max(2, Math.floor(rest.length / 4) * 2)
    const oldPortion = rest.slice(0, splitAt)
    const recentPortion = rest.slice(splitAt)

    const oldSignature = oldPortion.map(m => this.serializeMessage(m)).join('\n')
    if (this.summarizeCache !== null && this.summarizeCache.oldSignature === oldSignature) {
      const mergedRecent = prependSyntheticPrefixToFirstUser(
        recentPortion,
        `${this.summarizeCache.summaryPrefix}\n\n`,
      )
      return { messages: [firstUser, ...mergedRecent], usage: ZERO_USAGE }
    }

    const summaryPrompt = [
      'Summarize the following conversation history for an LLM.',
      '- Preserve user goals, constraints, and decisions.',
      '- Keep key tool outputs and unresolved questions.',
      '- Use concise bullets.',
      '- Do not fabricate details.',
    ].join('\n')

    const summaryInput: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: summaryPrompt },
          { type: 'text', text: `\n\nConversation:\n${oldSignature}` },
        ],
      },
    ]

    const summaryOptions: LLMChatOptions = {
      ...baseChatOptions,
      model: summaryModel ?? this.options.model,
      tools: undefined,
    }

    const summaryResponse = await this.chatWithCallTimeout(summaryInput, summaryOptions)

    const summaryText = extractText(summaryResponse.content).trim()
    const summaryPrefix = summaryText.length > 0
      ? `[Conversation summary]\n${summaryText}`
      : '[Conversation summary unavailable]'

    this.summarizeCache = { oldSignature, summaryPrefix }
    const mergedRecent = prependSyntheticPrefixToFirstUser(
      recentPortion,
      `${summaryPrefix}\n\n`,
    )
    return {
      messages: [firstUser, ...mergedRecent],
      usage: summaryResponse.usage,
    }
  }

  private async applyContextStrategy(
    messages: LLMMessage[],
    strategy: ContextStrategy,
    baseChatOptions: LLMChatOptions,
  ): Promise<{ messages: LLMMessage[]; usage: TokenUsage }> {
    return this.summarizeMessages(
      messages,
      strategy.maxTokens,
      strategy.summaryModel,
      baseChatOptions,
    )
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a complete conversation starting from `messages`.
   *
   * The call may internally make multiple LLM requests (one per tool-call
   * round-trip). It returns only when:
   *  - The LLM emits `end_turn` with no tool-use blocks, or
   *  - `maxTurns` is exceeded, or
   *  - The abort signal is triggered.
   */
  async run(
    initialMessages: LLMMessage[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    const restored = options.resumeState
    // Working copy of the conversation — mutated as turns progress.
    let conversationMessages: LLMMessage[] = restored
      ? [...restored.conversationMessages]
      : [...initialMessages]
    const newMessages: LLMMessage[] = restored ? [...restored.messages] : []

    // Accumulated state across all turns.
    let totalUsage: TokenUsage = restored?.tokenUsage ?? ZERO_USAGE
    const allToolCalls: ToolCallRecord[] = restored ? [...restored.toolCalls] : []
    let finalOutput = restored?.finalOutput ?? ''
    let turns = restored?.turns ?? 0
    let budgetExceeded = restored?.budgetExceeded ?? false
    let aborted = false
    let suspended = false
    let loopDetected = restored?.loopDetected ?? false
    let phase: InFlightTaskCheckpoint['phase'] = restored?.phase ?? 'awaiting_model'
    let pendingToolCalls: PendingToolCallCheckpoint[] = restored?.pendingToolCalls
      ? [...restored.pendingToolCalls]
      : []
    let pendingToolResultText = restored?.pendingToolResultText
    let loopWarned = restored?.loopWarned ?? false

    // Build the stable LLM options once; model / tokens / temp don't change.
    const toolDefs = this.toolRegistry.toToolDefs()
    // The single source of truth for what this agent may execute. The model is
    // only offered `toolDefs`, but a confused model (or prompt injection) can
    // still emit a tool_use for an unoffered name; gate execution on this set
    // so such a call can never run silently.
    const grantedToolNames = new Set(toolDefs.map((t) => t.name))

    // Per-call abortSignal takes precedence over the static one.
    const effectiveAbortSignal = options.abortSignal ?? this.options.abortSignal

    const persistCheckpoint = async (strict = false): Promise<void> => {
      if (!options.onCheckpoint || !options.taskId) return
      const assignee = this.options.agentName
      if (!assignee) return
      const state: InFlightTaskCheckpoint = {
        taskId: options.taskId,
        assignee,
        phase,
        conversationMessages: [...conversationMessages],
        messages: [...newMessages],
        tokenUsage: totalUsage,
        toolCalls: [...allToolCalls],
        turns,
        ...(phase === 'executing_tools'
          ? { pendingToolCalls: [...pendingToolCalls] }
          : {}),
        ...(phase === 'executing_tools' && pendingToolResultText !== undefined
          ? { pendingToolResultText }
          : {}),
        ...(phase === 'completed' ? { finalOutput } : {}),
        ...(loopWarned ? { loopWarned: true } : {}),
        ...(loopDetected ? { loopDetected: true } : {}),
        ...(budgetExceeded ? { budgetExceeded: true } : {}),
      }
      try {
        await options.onCheckpoint(state)
      } catch (error) {
        if (strict) throw error
        // Checkpoint delivery is best-effort and must never fail the agent run.
      }
    }

    const baseChatOptions: LLMChatOptions = {
      model: this.options.model,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      systemPrompt: this.options.systemPrompt,
      abortSignal: effectiveAbortSignal,
    }

    // Loop detection state — only allocated when configured.
    const detector = this.options.loopDetection
      ? new LoopDetector(this.options.loopDetection)
      : null
    if (detector !== null) {
      for (const message of conversationMessages) {
        if (message.role !== 'assistant') continue
        const historicalToolUseBlocks = extractToolUseBlocks(message.content)
        if (historicalToolUseBlocks.length > 0) {
          detector.recordToolCalls(historicalToolUseBlocks)
        }
        const historicalText = extractText(message.content)
        if (historicalText.length > 0) {
          detector.recordText(historicalText)
        }
      }
    }
    const loopAction = this.options.loopDetection?.onLoopDetected ?? 'warn'

    {
      // -----------------------------------------------------------------
      // Main agentic loop — `while (true)` until end_turn or maxTurns
      // -----------------------------------------------------------------
      while (true) {
        if (phase === 'completed') break

        if (phase === 'executing_tools') {
          const toolContext: ToolUseContext = this.buildToolContext(options)
          const executions = await Promise.all(pendingToolCalls.map(async (pending, index) => {
            if (pending.commit) {
              return { commit: pending.commit, shouldCommit: true } satisfies ToolExecution
            }

            if (pending.approvalRequest && !pending.approvalDecision) {
              return {
                commit: this.suspendedToolCommit(pending.call),
                shouldCommit: false,
                approvalRequest: pending.approvalRequest,
                suspension: {
                  content: pending.approvalRequest.content as ToolCallApprovalContent,
                  ...(pending.approvalRequest.reason !== undefined
                    ? { reason: pending.approvalRequest.reason }
                    : {}),
                },
              } satisfies ToolExecution
            }

            const execution = await this.executeToolCall(
              pending.call,
              grantedToolNames,
              toolContext,
              options,
              pending.approvalRequest && pending.approvalDecision
                ? {
                    request: pending.approvalRequest,
                    decision: pending.approvalDecision,
                  }
                : undefined,
            )
            if (execution.suspension) {
              const request = createApprovalRequest({
                runId: options.runId!,
                scope: 'tool_call',
                boundary: `${options.taskId!}:${pending.call.id}`,
                content: execution.suspension.content,
                ...(execution.suspension.reason !== undefined
                  ? { reason: execution.suspension.reason }
                  : {}),
              })
              await options.onApprovalPrepare!()
              pendingToolCalls[index] = { ...pending, approvalRequest: request }
              // A suspension is not reported until its exact in-flight state
              // is durable. Unlike ordinary recovery snapshots, failure here
              // must fail closed rather than pretending the run can resume.
              await persistCheckpoint(true)
              await options.onApprovalRequest!(request)
              return { ...execution, shouldCommit: false, approvalRequest: request }
            }
            if (execution.shouldCommit) {
              if (pending.approvalRequest) {
                await options.onApprovalConsumed?.(pending.approvalRequest.id)
              }
              pendingToolCalls[index] = { call: pending.call, commit: execution.commit }
              // Await the checkpoint before any fallible result callback so a
              // callback failure cannot turn a returned side effect into a
              // missing commit that restore would execute again.
              await persistCheckpoint()
            }
            if (execution.result !== undefined) {
              options.onToolResult?.(pending.call.name, execution.result)
            }
            return execution
          }))

          const suspendedExecutions = executions.filter(
            (execution): execution is ToolExecution & { readonly approvalRequest: ApprovalRequest } =>
              execution.approvalRequest !== undefined,
          )
          if (suspendedExecutions.length > 0) {
            suspended = true
            await persistCheckpoint(true)
            break
          }

          const toolResultBlocks: ContentBlock[] = executions.map(
            execution => execution.commit.result,
          )
          for (const execution of executions) {
            allToolCalls.push(execution.commit.record)
          }
          if (pendingToolResultText !== undefined) {
            toolResultBlocks.push({ type: 'text', text: pendingToolResultText })
          }

          const toolResultMessage: LLMMessage = {
            role: 'user',
            content: toolResultBlocks,
          }
          conversationMessages.push(toolResultMessage)
          newMessages.push(toolResultMessage)
          options.onMessage?.(toolResultMessage)

          const hasUncommittedCall = executions.some(execution => !execution.shouldCommit)
          if (hasUncommittedCall) {
            // Keep the last durable state at `executing_tools`. The current
            // cancelled result remains well-formed for this process, while a
            // later restore re-executes only the call that never committed.
            if (effectiveAbortSignal?.aborted) {
              aborted = true
              break
            }
            continue
          }

          pendingToolCalls = []
          pendingToolResultText = undefined

          phase = budgetExceeded ? 'completed' : 'awaiting_model'
          await persistCheckpoint()
          if (phase === 'completed') break
          continue
        }

        // Respect abort before each LLM call.
        if (effectiveAbortSignal?.aborted) {
          aborted = true
          break
        }

        // Guard against unbounded loops.
        if (turns >= this.maxTurns) {
          break
        }

        const nextTurn = turns + 1

        // Compress consumed tool results before context strategy (lightweight,
        // no LLM calls) so the strategy operates on already-reduced messages.
        if (this.options.compressToolResults && nextTurn > 1) {
          conversationMessages = this.compressConsumedToolResults(conversationMessages)
        }

        // Optionally compact context before each LLM call.
        if (this.options.contextStrategy) {
          const compacted = await this.applyContextStrategy(
            conversationMessages,
            this.options.contextStrategy,
            baseChatOptions,
          )
          conversationMessages = compacted.messages
          totalUsage = addTokenUsage(totalUsage, compacted.usage)
        }

        // ------------------------------------------------------------------
        // Step 1: Call the LLM and collect the full response for this turn.
        // ------------------------------------------------------------------
        const response = await this.chatWithCallTimeout(conversationMessages, baseChatOptions)

        totalUsage = addTokenUsage(totalUsage, response.usage)
        turns = nextTurn

        // ------------------------------------------------------------------
        // Step 2: Build the assistant message from the response content.
        // ------------------------------------------------------------------
        const assistantMessage: LLMMessage = {
          role: 'assistant',
          content: response.content,
        }

        conversationMessages.push(assistantMessage)
        newMessages.push(assistantMessage)
        options.onMessage?.(assistantMessage)

        const turnText = extractText(response.content)
        finalOutput = turnText

        const totalTokens = totalUsage.input_tokens + totalUsage.output_tokens
        // Defer the break to after tool_result is appended so we never leave
        // an unmatched tool_use block in conversationMessages (which would
        // cause a 400 on any subsequent API call that replays the history).
        if (this.options.maxTokenBudget !== undefined && totalTokens > this.options.maxTokenBudget) {
          budgetExceeded = true
          options.onWarning?.(new TokenBudgetExceededError(
            this.options.agentName ?? 'unknown',
            totalTokens,
            this.options.maxTokenBudget,
          ).message)
        }

        // Extract tool-use blocks for detection and execution.
        const toolUseBlocks = extractToolUseBlocks(response.content)

        // ------------------------------------------------------------------
        // Step 2.5: Loop detection, before any tool runs, so that terminate
        // mode never leaves a tool_use without its tool_result.
        // ------------------------------------------------------------------
        let injectWarning = false
        let injectWarningKind: 'tool_repetition' | 'text_repetition' = 'tool_repetition'
        if (detector) {
          const toolInfo = toolUseBlocks.length > 0
            ? detector.recordToolCalls(toolUseBlocks)
            : null
          const textInfo = turnText.length > 0 ? detector.recordText(turnText) : null
          const info = toolInfo ?? textInfo

          if (info) {
            options.onWarning?.(info.detail)

            const action = typeof loopAction === 'function'
              ? await loopAction(info)
              : loopAction

            if (action === 'terminate') {
              loopDetected = true
              finalOutput = turnText
              phase = 'completed'
              await persistCheckpoint()
              break
            } else if (action === 'warn' || action === 'inject') {
              if (loopWarned) {
                // Second detection after a warning — force terminate.
                loopDetected = true
                finalOutput = turnText
                phase = 'completed'
                  await persistCheckpoint()
                break
              }
              loopWarned = true
              injectWarning = true
              injectWarningKind = info.kind
              // Fall through to execute tools, then inject warning.
            }
            // 'continue' — do nothing, let the loop proceed normally.
          } else {
            // No loop detected this turn — agent has recovered, so reset
            // the warning state. A future loop gets a fresh warning cycle.
            loopWarned = false
          }
        }

        // ------------------------------------------------------------------
        // Step 3: Decide whether to continue looping.
        // ------------------------------------------------------------------
        if (toolUseBlocks.length === 0) {
          if (budgetExceeded) {
            phase = 'completed'
            await persistCheckpoint()
            break
          }
          if (injectWarning) {
            const warningMessage: LLMMessage = {
              role: 'user',
              content: [{ type: 'text', text: loopWarningText(injectWarningKind) }],
            }
            conversationMessages.push(warningMessage)
            newMessages.push(warningMessage)
            options.onMessage?.(warningMessage)
            phase = 'awaiting_model'
            await persistCheckpoint()
            continue
          }
          // Warn on first turn if tools were provided but model didn't use them.
          if (turns === 1 && toolDefs.length > 0 && options.onWarning) {
            const agentName = this.options.agentName ?? 'unknown'
            options.onWarning(
              `Agent "${agentName}" has ${toolDefs.length} tool(s) available but the model ` +
              `returned no tool calls. If using a local model, verify it supports tool calling ` +
              `(see https://ollama.com/search?c=tools).`,
            )
          }
          // No tools requested — this is the terminal assistant turn.
          finalOutput = turnText
          phase = 'completed'
          await persistCheckpoint()
          break
        }

        pendingToolCalls = toolUseBlocks.map(call => ({ call }))
        pendingToolResultText = injectWarning
          ? loopWarningText(injectWarningKind)
          : undefined
        phase = 'executing_tools'
        // Persist the assistant turn before any side effect begins. Each tool
        // result then advances its own commit record from this baseline.
        await persistCheckpoint()
      }
    }

    // If the loop exited due to maxTurns, use whatever text was last emitted.
    if (finalOutput === '' && conversationMessages.length > 0) {
      const lastAssistant = [...conversationMessages]
        .reverse()
        .find(m => m.role === 'assistant')
      if (lastAssistant !== undefined) {
        finalOutput = extractText(lastAssistant.content)
      }
    }

    const runResult: RunResult = {
      // Only the messages added during this run (not the initial seed).
      messages: newMessages,
      output: finalOutput,
      toolCalls: allToolCalls,
      tokenUsage: totalUsage,
      turns,
      ...(loopDetected ? { loopDetected: true } : {}),
      ...(budgetExceeded ? { budgetExceeded: true } : {}),
      ...(aborted ? { aborted: true } : {}),
      ...(suspended ? { suspended: true } : {}),
      ...(suspended
        ? {
            pendingApprovals: pendingToolCalls
              .map((pending) => pending.approvalRequest)
              .filter((request): request is ApprovalRequest => request !== undefined),
          }
        : {}),
    }

    return runResult
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async executeToolCall(
    block: ToolUseBlock,
    grantedToolNames: ReadonlySet<string>,
    toolContext: ToolUseContext,
    options: RunOptions,
    durableApproval?: {
      readonly request: ApprovalRequest
      readonly decision: ApprovalDecisionRecord
    },
  ): Promise<ToolExecution> {
    options.onToolCall?.(block.name, block.input)

    const startTime = Date.now()
    let result: ToolResult<any>

    if (!grantedToolNames.has(block.name)) {
      // Default-deny enforcement: the model asked for a tool that resolveTools()
      // did not grant. Surface a normal error result rather than executing it.
      result = {
        data:
          `Tool "${block.name}" is not granted to this agent. ` +
          'Only the tools offered to the model can run.',
        isError: true,
        ...(durableApproval
          ? { metadata: { approvalError: 'The reviewed tool is no longer granted.' } }
          : {}),
      }
    } else {
      try {
        const callContext: ToolUseContext = {
          ...toolContext,
          toolCallId: block.id,
        }
        result = await this.toolExecutor.execute(
          block.name,
          block.input,
          callContext,
          {
            onToolCall: this.options.onToolCall,
            ...(durableApproval ? { durableApproval } : {}),
          },
        )
      } catch (err) {
        // Tool executor errors become error results — the loop continues.
        const message = err instanceof Error ? err.message : String(err)
        result = { data: message, isError: true }
      }
    }

    const approvalContent = result.metadata?.approvalRequestContent
    const canSuspend = approvalContent !== undefined
      && options.onCheckpoint !== undefined
      && options.onApprovalPrepare !== undefined
      && options.onApprovalRequest !== undefined
      && options.taskId !== undefined
      && options.runId !== undefined
    if (approvalContent !== undefined && !canSuspend) {
      const { approvalRequestContent: _approvalRequestContent, ...metadata } = result.metadata ?? {}
      result = {
        data:
          `Tool "${block.name}" requested suspension, but durable tool approval requires ` +
          'an orchestrated task with checkpoint persistence and MemoryStore.compareAndSet.',
        isError: true,
        metadata,
      }
    }
    if (result.metadata?.approvalError) {
      const approvalError = typeof result.data === 'string'
        ? result.data
        : 'The reviewed tool returned a non-text approval error.'
      throw new DurableApprovalError('APPROVAL_STALE_DECISION', approvalError)
    }

    const endTime = Date.now()
    const duration = endTime - startTime
    // Keep callbacks/application consumers isolated from the transcript.
    // ToolExecutor already copied tool-owned input; this second copy means an
    // onToolResult callback cannot mutate what the model or checkpoint receives.
    const modelOutput = copyToolResultContent(modelOutputFromToolResult(result))
    const recordedOutput = result.modelOutput === undefined && typeof result.data === 'string'
      ? result.data
      : summarizeToolResultContent(modelOutput)

    const record: ToolCallRecord = {
      toolName: block.name,
      input: block.input,
      output: recordedOutput,
      duration,
    }
    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: block.id,
      content: modelOutput,
      is_error: result.isError,
    }

    return {
      commit: {
        result: resultBlock,
        record,
      },
      result,
      // An error result is normally plain committed data. The one exception is
      // a cancellation that became visible during this call: it represents the
      // conservative "no commit record" path and must run again after restore.
      shouldCommit: !(result.isError === true && toolContext.abortSignal?.aborted === true),
      ...(canSuspend
        ? {
            suspension: {
              content: approvalContent,
              ...(result.metadata?.toolCallGate?.reason !== undefined
                ? { reason: result.metadata.toolCallGate.reason }
                : {}),
            },
          }
        : {}),
    }
  }

  private suspendedToolCommit(block: ToolUseBlock): ToolCallCommitCheckpoint {
    const output = `Tool "${block.name}" is awaiting durable approval.`
    return {
      result: {
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
        is_error: true,
      },
      record: {
        toolName: block.name,
        input: block.input,
        output,
        duration: 0,
      },
    }
  }

  /**
   * Replace consumed tool results with compact markers.
   *
   * A tool_result is "consumed" when the assistant has produced a response
   * after seeing it (i.e. there is an assistant message following the user
   * message that contains the tool_result).  The most recent user message
   * with tool results is always kept intact — the LLM is about to see it.
   *
   * Error results and results shorter than `minChars` are never compressed.
   */
  private compressConsumedToolResults(
    messages: LLMMessage[],
  ): LLMMessage[] {
    const config = this.options.compressToolResults
    if (!config) return messages

    const minChars = typeof config === 'object'
      ? (config.minChars ?? DEFAULT_MIN_COMPRESS_CHARS)
      : DEFAULT_MIN_COMPRESS_CHARS

    // Find the last user message that carries tool_result blocks.
    let lastToolResultUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i]!.role === 'user' &&
        messages[i]!.content.some(b => b.type === 'tool_result')
      ) {
        lastToolResultUserIdx = i
        break
      }
    }

    // Nothing to compress if there's at most one tool-result user message.
    if (lastToolResultUserIdx <= 0) return messages

    let anyChanged = false
    const result = messages.map((msg, idx) => {
      // Only compress user messages that appear before the last one.
      if (msg.role !== 'user' || idx >= lastToolResultUserIdx) return msg

      const hasToolResult = msg.content.some(b => b.type === 'tool_result')
      if (!hasToolResult) return msg

      let msgChanged = false
      const newContent = msg.content.map((block): ContentBlock => {
        if (block.type !== 'tool_result') return block

        // Never compress error results — they carry diagnostic value.
        if (block.is_error) return block

        // Skip already-compressed results — avoid re-compression with wrong char count.
        if (
          typeof block.content === 'string' &&
          block.content.startsWith('[Tool output compressed')
        ) return block

        // Skip short results — the marker itself has overhead.
        const contentSize = toolResultContentSize(block.content)
        if (contentSize < minChars) return block

        msgChanged = true
        const sizeDescription = typeof block.content === 'string'
          ? `${contentSize} chars`
          : `${contentSize} estimated chars`
        const compressed: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: `[Tool output compressed — ${sizeDescription}, already processed]`,
        }
        return compressed
      })

      if (msgChanged) {
        anyChanged = true
        return { role: msg.role, content: newContent } as LLMMessage
      }
      return msg
    })

    return anyChanged ? result : messages
  }

  /**
   * Build the {@link ToolUseContext} passed to every tool execution.
   * Identifies this runner as the invoking agent.
   */
  private buildToolContext(
    options: RunOptions = {},
  ): ToolUseContext {
    return {
      agent: {
        name: this.options.agentName ?? 'runner',
        role: this.options.agentRole ?? 'assistant',
        model: this.options.model,
      },
      abortSignal: options.abortSignal ?? this.options.abortSignal,
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    }
  }
}
