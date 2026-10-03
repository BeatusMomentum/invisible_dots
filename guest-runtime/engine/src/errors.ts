// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * @fileoverview Framework-specific error classes.
 */


/**
 * Returned as a value when an agent or orchestrator run exceeds its configured
 * token budget. The framework never throws it: a run constructs one and
 * surfaces it through `classifyRunFailure` as a run `status` plus `errorInfo`,
 * or as the payload of a `budget_exceeded` stream event.
 */
export class TokenBudgetExceededError extends Error {
  readonly code = 'TOKEN_BUDGET_EXCEEDED'

  constructor(
    readonly agent: string,
    readonly tokensUsed: number,
    readonly budget: number,
  ) {
    super(`Agent "${agent}" exceeded token budget: ${tokensUsed} tokens used (budget: ${budget})`)
    this.name = 'TokenBudgetExceededError'
  }
}

/**
 * Returned as a value when an orchestrator run exceeds its configured estimated
 * cost budget. Surfaced the same way as {@link TokenBudgetExceededError} and
 * likewise never thrown by the framework.
 */
export class CostBudgetExceededError extends Error {
  readonly code = 'COST_BUDGET_EXCEEDED'

  constructor(
    readonly agent: string,
    readonly costUsed: number,
    readonly budget: number,
  ) {
    super(`Agent "${agent}" exceeded cost budget: ${costUsed} estimated cost used (budget: ${budget})`)
    this.name = 'CostBudgetExceededError'
  }
}

/**
 * Raised when a single LLM call (one `adapter.chat()` request) exceeds the
 * per-call deadline configured via {@link AgentConfig.callTimeoutMs}.
 *
 * Distinct from a whole-run timeout ({@link AgentConfig.timeoutMs}) and from a
 * caller-supplied `abortSignal` cancellation: the runner only raises this when
 * its own per-call deadline fired and the caller's signal did not, so a stalled
 * provider is observable and tellable apart from a deliberate abort.
 */
export class LLMCallTimeoutError extends Error {
  readonly code = 'LLM_CALL_TIMEOUT'

  constructor(
    /** The per-call deadline, in milliseconds, that was exceeded. */
    readonly timeoutMs: number,
    /** Name of the agent whose call timed out, when known. */
    readonly agent?: string,
  ) {
    super(
      agent !== undefined
        ? `Agent "${agent}" LLM call exceeded per-call timeout of ${timeoutMs}ms`
        : `LLM call exceeded per-call timeout of ${timeoutMs}ms`,
    )
    this.name = 'LLMCallTimeoutError'
  }
}

/**
 * Raised when structured input passed to a public Agent API or adapter violates
 * the {@link LLMMessage}[] contract (e.g. a `content` that isn't a
 * `ContentBlock[]`), cannot be copied safely, or crosses a text-only backend
 * boundary. Surfaced before provider-specific conversion or external execution.
 */
export class InvalidMessageError extends Error {
  readonly code = 'INVALID_MESSAGE'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidMessageError'
  }
}

/**
 * Detect caller-driven cancellation errors without importing a provider SDK.
 *
 * Standard aborts use `.name === 'AbortError'`. OpenAI SDK's
 * `APIUserAbortError` inherits the default `.name === 'Error'`, so its public
 * constructor name is the stable discriminator available at this boundary.
 */
export function isCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError'
    || error.constructor.name === 'APIUserAbortError'
}

