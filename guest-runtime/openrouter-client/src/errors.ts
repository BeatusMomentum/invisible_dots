/**
 * Typed errors. Callers branch on the class (or on `code`) to decide whether a
 * failure is the user's to fix (bad key, no credits) or transient.
 */

export type OpenRouterErrorCode =
  | "not_configured"
  | "bad_key"
  | "insufficient_credits"
  | "rate_limited"
  | "server_error"
  | "bad_request"
  | "network_error"
  | "timeout"
  | "aborted"
  | "invalid_response";

export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;
  /** HTTP status, or null when no answer arrived. */
  readonly status: number | null;
  /** Whether repeating the same request may succeed. */
  readonly retryable: boolean;
  /** The provider's own error message, when there was one. */
  readonly providerMessage: string | undefined;
  /** Milliseconds the server asked to wait before another attempt (Retry-After), when it said. */
  readonly retryAfterMs: number | null;

  constructor(
    code: OpenRouterErrorCode,
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      providerMessage?: string;
      retryAfterMs?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenRouterError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.providerMessage = options.providerMessage;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export class OpenRouterNotConfiguredError extends OpenRouterError {
  constructor() {
    super("not_configured", "the OpenRouter API key has not been pushed to this Dot yet (POST /secrets)");
    this.name = "OpenRouterNotConfiguredError";
  }
}

export class OpenRouterAuthError extends OpenRouterError {
  constructor(status: number, providerMessage?: string) {
    super("bad_key", `OpenRouter rejected the API key (HTTP ${status})${suffix(providerMessage)}`, {
      status,
      ...(providerMessage === undefined ? {} : { providerMessage }),
    });
    this.name = "OpenRouterAuthError";
  }
}

export class OpenRouterCreditsError extends OpenRouterError {
  constructor(status: number, providerMessage?: string) {
    super(
      "insufficient_credits",
      `the OpenRouter account has insufficient credits (HTTP ${status})${suffix(providerMessage)}`,
      { status, ...(providerMessage === undefined ? {} : { providerMessage }) },
    );
    this.name = "OpenRouterCreditsError";
  }
}

export class OpenRouterRateLimitError extends OpenRouterError {
  constructor(status: number, retryAfterMs: number | null, providerMessage?: string) {
    super("rate_limited", `OpenRouter rate limit hit (HTTP ${status})${suffix(providerMessage)}`, {
      status,
      retryable: true,
      retryAfterMs,
      ...(providerMessage === undefined ? {} : { providerMessage }),
    });
    this.name = "OpenRouterRateLimitError";
  }
}

function suffix(providerMessage: string | undefined): string {
  return providerMessage ? `: ${providerMessage}` : "";
}
