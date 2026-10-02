/**
 * The agent's HTTP API (architecture section 5.3), served on
 * `/run/invisible-dots/agent.sock` and reached by the host as `/v1/agent/...`
 * through dot-agentd, which has already checked the Dot's token. The socket is
 * owned by `dot` with mode 0600, so this server does no authentication itself.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentRuntime, Logger } from "@invisible-dots/agent-runtime";
import type { DotStore } from "@invisible-dots/memory";
import {
  AGENT_ROUTES,
  DotConfigError,
  parseInboundEvent,
  type AgentHealthAnswer,
  type DotRuntimeConfig,
  type ErrorAnswer,
  type GuestChecks,
  type OutboundEvent,
} from "@invisible-dots/shared";
import type { IdentityService } from "./identities.js";

export interface SecretSink {
  readonly configured: boolean;
  setApiKey(key: string): void;
}

export interface AgentServerDeps {
  runtime: Pick<AgentRuntime, "started" | "state" | "stateAnswer" | "accept" | "setConfig" | "modelConfigured" | "suspend">;
  store: Pick<DotStore, "readAfter" | "subscribe" | "checkpoint">;
  model: SecretSink;
  identities: IdentityService;
  checks: () => Promise<GuestChecks>;
  logger: Logger;
  /** Called after a config was accepted and persisted. */
  onConfig?: (config: DotRuntimeConfig) => Promise<void> | void;
  maxBodyBytes?: number;
  /** Interval of SSE comment lines that keep idle proxies from closing the stream. */
  heartbeatMs?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const IDENTITY_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid: 400,
  limit: 409,
  launch_failed: 502,
  crashed: 502,
};

export interface AgentServer {
  server: Server;
  /** Ends every open event stream, so `server.close()` can finish. */
  closeStreams(): void;
}

export function createAgentServer(deps: AgentServerDeps): AgentServer {
  const maxBody = deps.maxBodyBytes ?? 1024 * 1024;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const log = deps.logger;
  const streams = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    const started = Date.now();
    handle(req, res)
      .catch((error: unknown) => {
        const http =
          error instanceof HttpError
            ? error
            : isIdentityError(error)
              ? new HttpError(IDENTITY_ERROR_STATUS[error.code] ?? 500, error.code, error.message)
              : null;
        if (!http) log.error("request failed", { method: req.method, path: req.url, error: errorText(error) });
        const status = http?.status ?? 500;
        const body: ErrorAnswer = { error: http?.code ?? "internal", message: http?.message ?? errorText(error) };
        if (!res.headersSent) sendJson(res, status, body);
        else res.end();
      })
      .finally(() => {
        // The stream route stays open; it logs when it ends.
        if (!streams.has(res)) {
          log.debug("request", { method: req.method, path: pathOf(req), status: res.statusCode, duration_ms: Date.now() - started });
        }
      });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://agent");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (path === AGENT_ROUTES.health) {
      allow(method, "GET");
      const [checks, identities] = await Promise.all([deps.checks(), deps.identities.list()]);
      const answer: AgentHealthAnswer = {
        status: deps.runtime.started ? "ok" : "starting",
        state: deps.runtime.state,
        openrouter_configured: deps.model.configured,
        browser: { identities: identities.length, open: deps.identities.openCount },
        checks,
      };
      return sendJson(res, 200, answer);
    }

    if (path === AGENT_ROUTES.secrets) {
      allow(method, "POST");
      const body = await readJson(req, maxBody);
      const key = isRecord(body) ? body.openrouter_api_key : undefined;
      if (typeof key !== "string" || key.trim() === "") {
        throw new HttpError(400, "invalid_secret", "openrouter_api_key must be a non-empty string");
      }
      const replaced = deps.model.configured;
      deps.model.setApiKey(key);
      // Never the value, not even a prefix of it.
      log.info(replaced ? "OpenRouter key replaced" : "OpenRouter key received");
      deps.runtime.modelConfigured();
      return sendEmpty(res, 204);
    }

    if (path === AGENT_ROUTES.config) {
      allow(method, "PUT");
      const body = await readJson(req, maxBody);
      let config: DotRuntimeConfig;
      try {
        config = deps.runtime.setConfig(body);
      } catch (error) {
        if (error instanceof DotConfigError) throw new HttpError(400, "invalid_config", error.message);
        throw error;
      }
      await deps.onConfig?.(config);
      return sendEmpty(res, 204);
    }

    if (path === AGENT_ROUTES.events) {
      allow(method, "POST");
      const body = await readJson(req, maxBody);
      let event;
      try {
        event = parseInboundEvent(body);
      } catch (error) {
        throw new HttpError(400, "invalid_event", errorText(error));
      }
      try {
        deps.runtime.accept(event);
      } catch (error) {
        throw new HttpError(503, "shutting_down", errorText(error));
      }
      return sendJson(res, 202, { accepted: true });
    }

    if (path === AGENT_ROUTES.eventsStream) {
      allow(method, "GET");
      return stream(req, res, url);
    }

    if (path === AGENT_ROUTES.state) {
      allow(method, "GET");
      return sendJson(res, 200, deps.runtime.stateAnswer());
    }

    if (path === AGENT_ROUTES.browserIdentities) {
      if (method === "GET") return sendJson(res, 200, { identities: await deps.identities.list() });
      allow(method, "GET", "POST");
      const body = await readJson(req, maxBody);
      if (!isRecord(body) || typeof body.name !== "string") throw new HttpError(400, "invalid", "name must be a string");
      if (body.proxy !== undefined && typeof body.proxy !== "string") throw new HttpError(400, "invalid", "proxy must be a string");
      const identity = await deps.identities.create({ name: body.name, ...(body.proxy ? { proxy: body.proxy } : {}) });
      return sendJson(res, 201, identity);
    }

    if (path.startsWith(`${AGENT_ROUTES.browserIdentities}/`)) {
      const id = decodeURIComponent(path.slice(AGENT_ROUTES.browserIdentities.length + 1));
      if (id === "" || id.includes("/")) throw new HttpError(404, "not_found", `no route ${method} ${path}`);
      if (method === "GET") {
        const identity = await deps.identities.get(id);
        if (!identity) throw new HttpError(404, "not_found", `no browser identity "${id}"`);
        return sendJson(res, 200, identity);
      }
      allow(method, "GET", "DELETE");
      await deps.identities.delete(id);
      return sendEmpty(res, 204);
    }

    if (path === AGENT_ROUTES.prepareSleep) {
      allow(method, "POST");
      log.info("preparing to sleep");
      await deps.runtime.suspend();
      await deps.identities.closeAll();
      deps.store.checkpoint();
      log.info("ready to sleep: work paused, browsers closed, state flushed");
      return sendEmpty(res, 204);
    }

    throw new HttpError(404, "not_found", `no route ${method} ${path}`);
  }

  /**
   * Replay every event after `after`, then stream live ones. The subscription
   * starts before the replay and buffers, and every event is sent at most once
   * by seq, so nothing appended during the replay is lost or doubled.
   */
  async function stream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const raw = url.searchParams.get("after") ?? headerValue(req.headers["last-event-id"]) ?? "0";
    if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid_after", `after must be a non-negative integer, got "${raw}"`);
    let last = Number(raw);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    streams.add(res);
    log.info("event stream opened", { after: last });

    let live = false;
    let closed = false;
    const buffered: OutboundEvent[] = [];
    const send = (event: OutboundEvent): boolean => {
      if (closed || event.seq <= last) return true;
      last = event.seq;
      return res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = deps.store.subscribe((event) => {
      if (live) send(event);
      else buffered.push(event);
    });
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": keep-alive\n\n");
    }, heartbeatMs);
    heartbeat.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(res);
      log.info("event stream closed", { last_sent: last });
    };
    res.on("close", cleanup);

    for (;;) {
      const batch = deps.store.readAfter(last, 500);
      if (batch.length === 0 || closed) break;
      let flowing = true;
      for (const event of batch) flowing = send(event) && flowing;
      if (!flowing) await new Promise<void>((resolve) => res.once("drain", resolve).once("close", resolve));
    }
    live = true;
    for (const event of buffered.splice(0)) send(event);
  }

  return {
    server,
    closeStreams() {
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}

function allow(method: string, ...allowed: string[]): void {
  if (!allowed.includes(method)) {
    throw new HttpError(405, "method_not_allowed", `${method} is not allowed here; use ${allowed.join(" or ")}`);
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "payload_too_large", `the body is larger than ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw new HttpError(400, "invalid_json", "the body is empty; expected JSON");
  try {
    return JSON.parse(text);
  } catch {
    // Not the parser's message: it can quote the body, and the body of /secrets is a key.
    throw new HttpError(400, "invalid_json", "the body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentityError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === "BrowserIdentityError" && typeof (error as { code?: unknown }).code === "string";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pathOf(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
