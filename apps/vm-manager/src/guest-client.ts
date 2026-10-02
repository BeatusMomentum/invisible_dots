/**
 * The host's client for one Dot: every dot-agentd route (architecture 5.2) and
 * every agent route behind `/v1/agent` (5.3), over the Dot's bridge socket and
 * with the Dot's bearer token.
 */
import { request } from "node:http";
import {
  AGENTD_ROUTES,
  AGENT_ROUTES,
  httpOverSocket,
  parseOutboundEvent,
  SseParser,
  type AgentStateAnswer,
  type BrowserIdentity,
  type BrowserIdentityListAnswer,
  type CreateBrowserIdentityRequest,
  type DotRuntimeConfig,
  type ExecAnswer,
  type ExecRequest,
  type FileListAnswer,
  type HealthAnswer,
  type AgentHealthAnswer,
  type InboundEvent,
  type OutboundEvent,
  type PostEventAnswer,
  type SocketResponse,
  type SystemAnswer,
} from "@invisible-dots/shared";
import { GuestRequestError } from "./errors.js";
import { silentLogger, type Logger } from "./logger.js";

export interface GuestClientOptions {
  /** Per-request timeout. Default 30 s; exec adds its own timeout on top. */
  timeoutMs?: number;
  logger?: Logger;
}

export interface EventStreamOptions {
  /** Resume after this outbound `seq`; the stream sends only newer events. Default 0. */
  after?: number;
  signal?: AbortSignal;
  /** First reconnect delay; doubles up to `maxReconnectDelayMs`. Default 500 ms. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Called before each reconnect, e.g. to log it. */
  onReconnect?: (info: { after: number; attempt: number; error: Error }) => void;
}

interface Call {
  method?: string;
  path: string;
  body?: unknown;
  rawBody?: Uint8Array;
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function filesQuery(path: string): string {
  return `?path=${encodeURIComponent(path)}`;
}

function parseError(route: string, response: SocketResponse): GuestRequestError {
  const text = response.body.toString("utf8");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") {
      return new GuestRequestError(
        route,
        response.status,
        typeof parsed.message === "string" ? `${parsed.error}: ${parsed.message}` : parsed.error,
        parsed.error,
      );
    }
  } catch {
    // Not JSON: the raw text is the most useful message.
  }
  const hint = response.status === 401 ? " (the Dot token was refused)" : "";
  return new GuestRequestError(route, response.status, `${text.trim().slice(0, 500) || "no body"}${hint}`);
}

export class GuestClient {
  readonly socketPath: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(socketPath: string, token: string, options: GuestClientOptions = {}) {
    if (!token) throw new Error("GuestClient needs the Dot token");
    this.socketPath = socketPath;
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = options.logger ?? silentLogger;
  }

  private async send(call: Call): Promise<SocketResponse> {
    const method = call.method ?? "GET";
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let body: string | Uint8Array | undefined;
    if (call.rawBody !== undefined) {
      body = call.rawBody;
      headers["content-type"] = call.contentType ?? "application/octet-stream";
    } else if (call.body !== undefined) {
      body = JSON.stringify(call.body);
      headers["content-type"] = "application/json";
    }
    const response = await httpOverSocket(this.socketPath, {
      method,
      path: call.path,
      headers,
      body,
      timeoutMs: call.timeoutMs ?? this.timeoutMs,
      signal: call.signal,
    });
    if (response.status < 200 || response.status >= 300) throw parseError(`${method} ${call.path}`, response);
    return response;
  }

  private async json<T>(call: Call): Promise<T> {
    const response = await this.send(call);
    const text = response.body.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GuestRequestError(`${call.method ?? "GET"} ${call.path}`, response.status, `answer is not JSON: ${text.slice(0, 200)}`);
    }
  }

  private async noContent(call: Call): Promise<void> {
    await this.send(call);
  }

  private agentPath(path: string): string {
    return `${AGENTD_ROUTES.agent}${path}`;
  }

  // dot-agentd (5.2)

  health(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HealthAnswer> {
    return this.json({ path: AGENTD_ROUTES.health, ...options });
  }

  system(): Promise<SystemAnswer> {
    return this.json({ path: AGENTD_ROUTES.system });
  }

  exec(body: ExecRequest): Promise<ExecAnswer> {
    // The command may legitimately run for timeout_ms; give the transport that long plus a margin.
    const timeoutMs = body.timeout_ms === undefined ? undefined : body.timeout_ms + this.timeoutMs;
    return this.json({ method: "POST", path: AGENTD_ROUTES.exec, body, timeoutMs });
  }

  async readFile(path: string): Promise<Buffer> {
    return (await this.send({ path: `${AGENTD_ROUTES.files}${filesQuery(path)}` })).body;
  }

  writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const rawBody = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return this.noContent({ method: "PUT", path: `${AGENTD_ROUTES.files}${filesQuery(path)}`, rawBody });
  }

  listFiles(path: string): Promise<FileListAnswer> {
    return this.json({ path: `${AGENTD_ROUTES.filesList}${filesQuery(path)}` });
  }

  /** PNG bytes of display :0. */
  async screenshot(): Promise<Buffer> {
    return (await this.send({ path: AGENTD_ROUTES.screenshot })).body;
  }

  // invisible-dots-agent (5.3), through /v1/agent

  agentHealth(): Promise<AgentHealthAnswer> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.health) });
  }

  pushSecrets(openrouterApiKey: string): Promise<void> {
    return this.noContent({
      method: "POST",
      path: this.agentPath(AGENT_ROUTES.secrets),
      body: { openrouter_api_key: openrouterApiKey },
    });
  }

  putConfig(config: DotRuntimeConfig): Promise<void> {
    return this.noContent({ method: "PUT", path: this.agentPath(AGENT_ROUTES.config), body: config });
  }

  postEvent(event: InboundEvent): Promise<PostEventAnswer> {
    return this.json({ method: "POST", path: this.agentPath(AGENT_ROUTES.events), body: event });
  }

  state(): Promise<AgentStateAnswer> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.state) });
  }

  listBrowserIdentities(): Promise<BrowserIdentityListAnswer> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.browserIdentities) });
  }

  createBrowserIdentity(body: CreateBrowserIdentityRequest): Promise<BrowserIdentity> {
    return this.json({ method: "POST", path: this.agentPath(AGENT_ROUTES.browserIdentities), body });
  }

  getBrowserIdentity(id: string): Promise<BrowserIdentity> {
    return this.json({ path: this.agentPath(AGENT_ROUTES.browserIdentity(id)) });
  }

  deleteBrowserIdentity(id: string): Promise<void> {
    return this.noContent({ method: "DELETE", path: this.agentPath(AGENT_ROUTES.browserIdentity(id)) });
  }

  /** Flushes state and closes browser sessions; can take a while with several browsers open. */
  prepareSleep(timeoutMs = 60_000): Promise<void> {
    return this.noContent({ method: "POST", path: this.agentPath(AGENT_ROUTES.prepareSleep), timeoutMs });
  }

  /**
   * The outbound event stream, as an async iterator that survives disconnects:
   * on any network error or end of stream it reconnects with `?after=<last
   * seq seen>`, so an event is neither lost nor delivered twice. It ends only
   * when `signal` aborts or the consumer stops iterating. A 401 is not
   * retried: a wrong token does not get better by waiting.
   */
  async *events(options: EventStreamOptions = {}): AsyncGenerator<OutboundEvent, void, undefined> {
    let after = options.after ?? 0;
    const firstDelay = options.reconnectDelayMs ?? 500;
    const maxDelay = options.maxReconnectDelayMs ?? 15_000;
    let attempt = 0;
    const signal = options.signal;
    while (!signal?.aborted) {
      const stream = this.openStream(after, signal);
      let lastError: Error | undefined;
      try {
        for await (const event of stream) {
          attempt = 0;
          if (event.seq <= after) continue;
          after = event.seq;
          yield event;
        }
        lastError = new Error("event stream ended");
      } catch (error) {
        if (error instanceof GuestRequestError && (error.status === 401 || error.status === 404)) throw error;
        lastError = error as Error;
      } finally {
        await stream.return(undefined);
      }
      if (signal?.aborted) return;
      attempt++;
      options.onReconnect?.({ after, attempt, error: lastError });
      this.logger.warn("guest event stream reconnecting", { socket: this.socketPath, after, attempt, reason: lastError.message });
      await abortableSleep(Math.min(firstDelay * 2 ** (attempt - 1), maxDelay), signal);
    }
  }

  /** One connection to `/events/stream`, parsed into events; ends when the connection ends. */
  private async *openStream(after: number, signal: AbortSignal | undefined): AsyncGenerator<OutboundEvent, void, undefined> {
    const path = `${this.agentPath(AGENT_ROUTES.eventsStream)}?after=${after}`;
    const route = `GET ${path}`;
    const req = request({
      socketPath: this.socketPath,
      method: "GET",
      path,
      agent: false,
      headers: { host: "localhost", authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
      signal,
    });
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      req.once("response", resolve);
      req.once("error", reject);
      req.end();
    });
    try {
      if ((response.statusCode ?? 0) !== 200) {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(chunk as Buffer);
        throw parseError(route, { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      }
      response.setEncoding("utf8");
      const parser = new SseParser();
      for await (const chunk of response) {
        for (const message of parser.feed(chunk as string)) {
          if (message.data === "") continue;
          let event: OutboundEvent;
          try {
            event = parseOutboundEvent(JSON.parse(message.data));
          } catch (error) {
            // One malformed message must not stall the stream forever; it is logged and skipped.
            this.logger.error("guest sent an invalid event, skipped", { id: message.id, error: (error as Error).message });
            continue;
          }
          yield event;
        }
      }
    } finally {
      req.destroy();
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
