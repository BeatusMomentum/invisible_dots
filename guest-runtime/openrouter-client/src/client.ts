/**
 * The only LLM client of a Dot (architecture section 8.5): OpenRouter
 * chat.completions over fetch, tool calling in the OpenAI format, no
 * streaming, retries with exponential backoff on 429 and 5xx.
 */
import { OPENROUTER_CHAT_URL, OPENROUTER_REFERER, OPENROUTER_TITLE } from "@invisible-dots/shared";
import {
  OpenRouterAuthError,
  OpenRouterCreditsError,
  OpenRouterError,
  OpenRouterNotConfiguredError,
  OpenRouterRateLimitError,
} from "./errors.js";
import type {
  AssistantMessage,
  ChatModel,
  ChatOptions,
  ChatRequest,
  ChatResult,
  ParsedToolCall,
  ToolCall,
  Usage,
} from "./types.js";

export interface OpenRouterLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  debug?(message: string, fields?: Record<string, unknown>): void;
}

export interface OpenRouterClientOptions {
  /** May be omitted and set later with `setApiKey`, once the host pushes it. */
  apiKey?: string;
  /** Overrides the chat completions URL, for tests and proxies. */
  url?: string;
  fetch?: typeof globalThis.fetch;
  /** Total attempts including the first one. The contract caps it at 4. */
  maxAttempts?: number;
  /** First backoff delay; it doubles on every retry. */
  baseDelayMs?: number;
  /** No single wait is longer than this, even when Retry-After asks for more. */
  maxDelayMs?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: OpenRouterLogger;
}

const DEFAULT_MAX_ATTEMPTS = 4;

export class OpenRouterClient implements ChatModel {
  #apiKey: string | undefined;
  readonly #url: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #logger: OpenRouterLogger | undefined;

  constructor(options: OpenRouterClientOptions = {}) {
    this.#apiKey = options.apiKey || undefined;
    this.#url = options.url ?? OPENROUTER_CHAT_URL;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxAttempts = Math.min(Math.max(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1), DEFAULT_MAX_ATTEMPTS);
    this.#baseDelayMs = options.baseDelayMs ?? 1000;
    this.#maxDelayMs = options.maxDelayMs ?? 60_000;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#logger = options.logger;
  }

  get configured(): boolean {
    return this.#apiKey !== undefined;
  }

  /** Replace the key. It lives in this object only and is never logged. */
  setApiKey(apiKey: string): void {
    if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("the OpenRouter API key must be a non-empty string");
    this.#apiKey = apiKey.trim();
  }

  async chat(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
    const apiKey = this.#apiKey;
    if (apiKey === undefined) throw new OpenRouterNotConfiguredError();

    const body = JSON.stringify({
      ...request,
      ...(request.tools && request.tools.length > 0 ? { tool_choice: "auto" } : {}),
      stream: false,
      // Asks OpenRouter to report the cost of the generation in `usage`.
      usage: { include: true },
    });

    let lastError: OpenRouterError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      throwIfAborted(options.signal);
      let waitMs: number | null = null;
      try {
        const result = await this.#attempt(apiKey, body, options.signal);
        return { ...result, attempts: attempt };
      } catch (error) {
        if (!(error instanceof OpenRouterError)) throw error;
        lastError = error;
        if (!error.retryable || attempt === this.#maxAttempts) throw error;
        const backoff = this.#baseDelayMs * 2 ** (attempt - 1);
        waitMs = Math.min(Math.max(error.retryAfterMs ?? backoff, 0), this.#maxDelayMs);
        this.#logger?.warn("openrouter request failed, retrying", {
          attempt,
          max_attempts: this.#maxAttempts,
          code: error.code,
          status: error.status,
          wait_ms: waitMs,
        });
      }
      try {
        await this.#sleep(waitMs, options.signal);
      } catch (cause) {
        throw new OpenRouterError("aborted", "the OpenRouter request was aborted", { cause });
      }
    }
    // Unreachable: the loop either returns or throws on its last attempt.
    throw lastError ?? new OpenRouterError("network_error", "OpenRouter request failed");
  }

  async #attempt(apiKey: string, body: string, signal: AbortSignal | undefined): Promise<Omit<ChatResult, "attempts">> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "HTTP-Referer": OPENROUTER_REFERER,
          "X-Title": OPENROUTER_TITLE,
        },
        body,
        signal: combined,
      });
    } catch (cause) {
      if (signal?.aborted) throw new OpenRouterError("aborted", "the OpenRouter request was aborted", { cause });
      if (timeout.aborted) {
        throw new OpenRouterError("timeout", `OpenRouter did not answer within ${this.#timeoutMs} ms`, {
          retryable: true,
          cause,
        });
      }
      throw new OpenRouterError("network_error", `could not reach OpenRouter: ${describeCause(cause)}`, {
        retryable: true,
        cause,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (signal?.aborted) throw new OpenRouterError("aborted", "the OpenRouter request was aborted", { cause });
      throw new OpenRouterError("network_error", `OpenRouter answer interrupted: ${describeCause(cause)}`, {
        status: response.status,
        retryable: true,
        cause,
      });
    }
    const json = tryParseJson(text);

    if (!response.ok) {
      throw errorForStatus(response.status, providerMessageOf(json) ?? snippet(text), parseRetryAfter(response.headers.get("retry-after")));
    }

    // OpenRouter sometimes answers 200 with an `error` object when the upstream provider failed.
    const embedded = embeddedError(json);
    if (embedded) throw errorForStatus(embedded.status, embedded.message, null);

    return parseCompletion(json, text);
  }
}

function errorForStatus(status: number, providerMessage: string | undefined, retryAfterMs: number | null): OpenRouterError {
  const extra = providerMessage === undefined ? {} : { providerMessage };
  if (status === 401 || status === 403) return new OpenRouterAuthError(status, providerMessage);
  if (status === 402) return new OpenRouterCreditsError(status, providerMessage);
  if (status === 429) return new OpenRouterRateLimitError(status, retryAfterMs, providerMessage);
  if (status >= 500) {
    return new OpenRouterError(
      "server_error",
      `OpenRouter server error (HTTP ${status})${providerMessage ? `: ${providerMessage}` : ""}`,
      { status, retryable: true, retryAfterMs, ...extra },
    );
  }
  return new OpenRouterError(
    "bad_request",
    `OpenRouter refused the request (HTTP ${status})${providerMessage ? `: ${providerMessage}` : ""}`,
    { status, ...extra },
  );
}

/** Retry-After is either delta-seconds or an HTTP date (RFC 9110 section 10.2.3). */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(date - now, 0);
}

function parseCompletion(json: unknown, raw: string): Omit<ChatResult, "attempts"> {
  if (!isRecord(json)) {
    throw new OpenRouterError("invalid_response", `OpenRouter answered with something that is not JSON: ${snippet(raw)}`, {
      retryable: true,
    });
  }
  const choices = json.choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  if (!isRecord(choice) || !isRecord(choice.message)) {
    // An empty choices list is what a provider hiccup looks like; another attempt usually works.
    throw new OpenRouterError("invalid_response", `OpenRouter answer has no choices: ${snippet(raw)}`, { retryable: true });
  }
  const rawMessage = choice.message;
  const content = typeof rawMessage.content === "string" ? rawMessage.content : null;
  const toolCalls = normalizeToolCalls(rawMessage.tool_calls);

  const message: AssistantMessage = { role: "assistant", content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    message,
    text: content ?? "",
    toolCalls: toolCalls.map(parseToolCall),
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: parseUsage(json.usage),
    model: typeof json.model === "string" ? json.model : "",
    generationId: typeof json.id === "string" ? json.id : null,
  };
}

function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.function)) return;
    const name = entry.function.name;
    if (typeof name !== "string" || name === "") return;
    const args = entry.function.arguments;
    calls.push({
      // Some providers omit the id; the history still needs one to pair the tool result with.
      id: typeof entry.id === "string" && entry.id !== "" ? entry.id : `call_${index}_${Date.now().toString(36)}`,
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args) },
    });
  });
  return calls;
}

/** Decode the JSON arguments of one tool call; never throws. */
export function parseToolCall(call: ToolCall): ParsedToolCall {
  const raw = call.function.arguments;
  const base = { id: call.id, name: call.function.name, rawArguments: raw };
  if (raw.trim() === "") return { ...base, arguments: {} };
  const parsed = tryParseJson(raw);
  if (parsed === undefined) return { ...base, arguments: null, argumentsError: "the arguments are not valid JSON" };
  if (!isRecord(parsed)) return { ...base, arguments: null, argumentsError: "the arguments must be a JSON object" };
  return { ...base, arguments: parsed };
}

function parseUsage(value: unknown): Usage {
  if (!isRecord(value)) return { prompt_tokens: 0, completion_tokens: 0 };
  const usage: Usage = {
    prompt_tokens: finiteOr(value.prompt_tokens, 0),
    completion_tokens: finiteOr(value.completion_tokens, 0),
  };
  if (typeof value.cost === "number" && Number.isFinite(value.cost)) usage.cost = value.cost;
  return usage;
}

function embeddedError(json: unknown): { status: number; message: string | undefined } | null {
  if (!isRecord(json) || !isRecord(json.error)) return null;
  const code = json.error.code;
  const status = typeof code === "number" && code >= 400 && code < 600 ? code : 502;
  return { status, message: typeof json.error.message === "string" ? json.error.message : undefined };
}

function providerMessageOf(json: unknown): string | undefined {
  if (isRecord(json) && isRecord(json.error) && typeof json.error.message === "string") return json.error.message;
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function snippet(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as Error & { cause?: unknown }).cause;
    return inner instanceof Error ? `${cause.message} (${inner.message})` : cause.message;
  }
  return String(cause);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OpenRouterError("aborted", "the OpenRouter request was aborted", { cause: signal.reason });
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
