/**
 * Typed client for every route of the control-plane API (architecture
 * section 9.6), built on `fetch` so it runs in Node and in browsers.
 */
import { SseParser, type ApprovalStatus, type BrowserIdentity, type StoredEvent } from "@invisible-dots/shared/browser";
import type {
  AcceptedAnswer,
  ApprovalRecord,
  ApprovalsAnswer,
  ComputerAnswer,
  ConversationMessage,
  CreateTaskRequest,
  DotRecord,
  DotsAnswer,
  DotSummary,
  EventsAnswer,
  HealthResponse,
  IdentitiesAnswer,
  MessageAnswer,
  MessagesAnswer,
  TaskRecord,
  TasksAnswer,
} from "./types.js";

/** An `{ error, message }` answer of the API, or a failure to reach it (`status` 0, `code` "unreachable"). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  /** e.g. `http://127.0.0.1:8787`; "" for same-origin requests from a page served next to the API. */
  baseUrl: string;
  /**
   * The API token. Omitted by the web client, whose same-origin server adds
   * it, so the token never reaches the browser.
   */
  token?: string;
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (not applied to the event stream). Default 30 s. */
  timeoutMs?: number;
}

export interface StreamOptions {
  /** Only events of this Dot (id or name are both accepted by the server for other routes; the stream takes the id). */
  dotId?: string;
  /** Replay stored events with an id greater than this first. */
  after?: number;
  signal?: AbortSignal;
  /** Reconnect after a dropped connection, resuming after the last event seen. Default true. */
  reconnect?: boolean;
  /** Called each time a connection is established, before its first event. */
  onOpen?: () => void;
  /** Called before every reconnect. */
  onReconnect?: (info: { after: number | undefined; attempt: number; error: Error }) => void;
}

type Query = Record<string, string | number | undefined>;

/** The SSE event name the server sends right before it ends a stream because of an error. */
export const STREAM_ERROR_EVENT = "stream-error";

const enc = encodeURIComponent;

export class InvisibleDotsClient {
  readonly baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  #authHeaders(): Record<string, string> {
    return this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` };
  }

  #url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  async #send(method: string, path: string, options: { body?: unknown; query?: Query; accept?: string } = {}): Promise<Response> {
    const headers = this.#authHeaders();
    if (options.accept) headers.accept = options.accept;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const url = this.#url(path, options.query);
    let response: Response;
    try {
      response = await this.#fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new ApiError(0, "unreachable", `cannot reach the invisible_dots API at ${this.baseUrl}: ${reason}`);
    }
    if (!response.ok) throw await toApiError(response, `${method} ${path}`);
    return response;
  }

  async #json<T>(method: string, path: string, options: { body?: unknown; query?: Query } = {}): Promise<T> {
    const response = await this.#send(method, path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // Health and secrets

  health(): Promise<HealthResponse> {
    return this.#json("GET", "/api/health");
  }

  setOpenRouterKey(value: string, dotId?: string): Promise<{ pushed: number }> {
    return this.#json("PUT", "/api/secrets/openrouter", { body: dotId === undefined ? { value } : { value, dot_id: dotId } });
  }

  // Dots

  createDot(config: string | Record<string, unknown>): Promise<DotRecord> {
    return this.#json("POST", "/api/dots", { body: { config } });
  }

  async listDots(): Promise<DotSummary[]> {
    return (await this.#json<DotsAnswer>("GET", "/api/dots")).dots;
  }

  /** By id or by name. */
  getDot(idOrName: string): Promise<DotSummary> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}`);
  }

  updateDot(idOrName: string, config: string | Record<string, unknown>): Promise<DotRecord> {
    return this.#json("PATCH", `/api/dots/${enc(idOrName)}`, { body: { config } });
  }

  deleteDot(idOrName: string): Promise<AcceptedAnswer> {
    return this.#json("DELETE", `/api/dots/${enc(idOrName)}`);
  }

  // Messages and tasks

  sendMessage(idOrName: string, text: string): Promise<MessageAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/messages`, { body: { text } });
  }

  async messages(idOrName: string): Promise<ConversationMessage[]> {
    return (await this.#json<MessagesAnswer>("GET", `/api/dots/${enc(idOrName)}/messages`)).messages;
  }

  createTask(idOrName: string, request: CreateTaskRequest): Promise<TaskRecord> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/tasks`, { body: request });
  }

  async listTasks(idOrName: string): Promise<TaskRecord[]> {
    return (await this.#json<TasksAnswer>("GET", `/api/dots/${enc(idOrName)}/tasks`)).tasks;
  }

  getTask(taskId: string): Promise<TaskRecord> {
    return this.#json("GET", `/api/tasks/${enc(taskId)}`);
  }

  cancelTask(taskId: string): Promise<TaskRecord> {
    return this.#json("POST", `/api/tasks/${enc(taskId)}/cancel`);
  }

  // Computer

  computer(idOrName: string): Promise<ComputerAnswer> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}/computer`);
  }

  startComputer(idOrName: string): Promise<AcceptedAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/computer/start`);
  }

  stopComputer(idOrName: string): Promise<AcceptedAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/computer/stop`);
  }

  rebootComputer(idOrName: string): Promise<AcceptedAnswer> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/computer/reboot`);
  }

  /** PNG bytes of the Dot's display. */
  async screenshot(idOrName: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.#send("GET", `/api/dots/${enc(idOrName)}/computer/screenshot`, { accept: "image/png" });
    return new Uint8Array(await response.arrayBuffer());
  }

  // Browser identities

  async listIdentities(idOrName: string): Promise<BrowserIdentity[]> {
    return (await this.#json<IdentitiesAnswer>("GET", `/api/dots/${enc(idOrName)}/browser-identities`)).identities;
  }

  createIdentity(idOrName: string, request: { name: string; proxy?: string }): Promise<BrowserIdentity> {
    return this.#json("POST", `/api/dots/${enc(idOrName)}/browser-identities`, { body: request });
  }

  getIdentity(idOrName: string, identityId: string): Promise<BrowserIdentity> {
    return this.#json("GET", `/api/dots/${enc(idOrName)}/browser-identities/${enc(identityId)}`);
  }

  async deleteIdentity(idOrName: string, identityId: string): Promise<void> {
    await this.#json("DELETE", `/api/dots/${enc(idOrName)}/browser-identities/${enc(identityId)}`);
  }

  // Approvals

  async listApprovals(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    return (await this.#json<ApprovalsAnswer>("GET", "/api/approvals", { query: { status } })).approvals;
  }

  approve(approvalId: string, note?: string): Promise<ApprovalRecord> {
    return this.#json("POST", `/api/approvals/${enc(approvalId)}/approve`, { body: note === undefined ? {} : { note } });
  }

  reject(approvalId: string, note?: string): Promise<ApprovalRecord> {
    return this.#json("POST", `/api/approvals/${enc(approvalId)}/reject`, { body: note === undefined ? {} : { note } });
  }

  // Events

  async events(idOrName: string, options: { after?: number; limit?: number } = {}): Promise<StoredEvent[]> {
    return (
      await this.#json<EventsAnswer>("GET", `/api/dots/${enc(idOrName)}/events`, {
        query: { after: options.after, limit: options.limit },
      })
    ).events;
  }

  /**
   * `GET /api/stream` as an async iterator of stored events. With `reconnect`
   * (the default) a dropped connection is resumed after the last event seen,
   * so nothing is missed; authentication and other 4xx errors are thrown.
   */
  async *stream(options: StreamOptions = {}): AsyncGenerator<StoredEvent, void, undefined> {
    let after = options.after;
    let attempt = 0;
    const reconnect = options.reconnect ?? true;
    for (;;) {
      if (options.signal?.aborted) return;
      let failure: Error;
      try {
        const response = await this.#openStream(options.dotId, after, options.signal);
        options.onOpen?.();
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        const parser = new SseParser();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const message of parser.feed(value)) {
              if (message.event === STREAM_ERROR_EVENT) {
                const info = JSON.parse(message.data) as { message?: string };
                throw new Error(`the server closed the event stream: ${info.message ?? "unknown reason"}`);
              }
              const event = JSON.parse(message.data) as StoredEvent;
              after = event.id;
              attempt = 0;
              yield event;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        failure = new Error("the event stream ended");
      } catch (error) {
        if (options.signal?.aborted) return;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
        failure = error instanceof Error ? error : new Error(String(error));
      }
      if (!reconnect || options.signal?.aborted) {
        if (options.signal?.aborted) return;
        throw failure;
      }
      attempt++;
      options.onReconnect?.({ after, attempt, error: failure });
      await delay(Math.min(500 * 2 ** (attempt - 1), 15_000), options.signal);
    }
  }

  async #openStream(dotId: string | undefined, after: number | undefined, signal?: AbortSignal): Promise<Response> {
    const url = this.#url("/api/stream", { dot_id: dotId, after });
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { ...this.#authHeaders(), accept: "text/event-stream" },
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new ApiError(0, "unreachable", `cannot reach the invisible_dots API at ${this.baseUrl}: ${reason}`);
    }
    if (!response.ok) throw await toApiError(response, "GET /api/stream");
    if (!response.body) throw new ApiError(502, "bad_stream", "the event stream answer has no body");
    return response;
  }
}

async function toApiError(response: Response, route: string): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; details?: unknown };
    if (typeof body.error === "string") {
      return new ApiError(response.status, body.error, typeof body.message === "string" ? body.message : body.error, body.details);
    }
  } catch {
    // Not JSON; the text itself is the message.
  }
  return new ApiError(response.status, `http_${response.status}`, `${route}: HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
