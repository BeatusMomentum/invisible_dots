/**
 * The control-plane HTTP API of architecture section 9.6. Every route needs
 * the bearer token; every error is `{ error, message }`. The handlers are
 * thin: the work happens in the Scheduler.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { TELEGRAM_TOKEN_SECRET, type ChannelHub } from "@invisible-dots/channels";
import { StreamOverflowError } from "@invisible-dots/events";
import { ControlPlaneError, errorMessage, silentLogger, type Logger, type Scheduler } from "@invisible-dots/scheduler";
import { STREAM_ERROR_EVENT } from "@invisible-dots/sdk";
import type {
  ApprovalsAnswer,
  ChannelPairingAnswer,
  ChannelRecord,
  ChannelsAnswer,
  DotsAnswer,
  EventsAnswer,
  HealthResponse,
  IdentitiesAnswer,
  MessagesAnswer,
  TasksAnswer,
  UsageAnswer,
} from "@invisible-dots/sdk/types";
import { APPROVAL_STATUSES, CHANNEL_KINDS, type ApprovalStatus, type ChannelKind } from "@invisible-dots/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

export const API_VERSION = "0.1.0";

/** A comment line on idle SSE connections, so proxies and clients see the connection is alive. */
export const SSE_HEARTBEAT_MS = 15_000;

export interface ServerOptions {
  scheduler: Scheduler;
  channels: ChannelHub;
  token: string;
  logger?: Logger;
  heartbeatMs?: number;
}

type Params = { id: string; identityId: string; kind: string; peer: string };
type Body = Record<string, unknown> | undefined;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bad(message: string): ControlPlaneError {
  return new ControlPlaneError(400, "invalid_request", message);
}

/** A non-negative integer query parameter, or undefined when absent. */
function intParam(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) > max) {
    throw bad(`${name} must be a non-negative integer${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ""}`);
  }
  return Number(value);
}

/** An ISO 8601 date-time query parameter, or undefined when absent. */
function sinceParam(value: unknown): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : undefined;
  if (parsed === undefined || Number.isNaN(parsed.getTime())) {
    throw bad("since must be an ISO 8601 timestamp such as 2026-10-05T00:00:00Z");
  }
  return parsed;
}

function channelKind(value: string): ChannelKind {
  if (!(CHANNEL_KINDS as readonly string[]).includes(value)) throw bad(`no "${value}" channel: the channels are ${CHANNEL_KINDS.join(", ")}`);
  return value as ChannelKind;
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body as Body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw bad("the body must be a JSON object");
  return body;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { scheduler, channels } = options;
  const log = options.logger ?? silentLogger;
  const expected = digest(options.token);
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const streams = new Set<AbortController>();

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, return503OnClosing: true });

  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    // Comparing digests keeps the comparison constant-time whatever the length of the guess.
    if (!match || !timingSafeEqual(digest(match[1]!.trim()), expected)) {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="invisible-dots"')
        .send({ error: "unauthorized", message: "a valid Authorization: Bearer <api token> header is required" });
    }
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ error: "not_found", message: `no route ${request.method} ${request.url.split("?")[0]}` });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ControlPlaneError) {
      const body: Record<string, unknown> = { error: error.code, message: error.message };
      if (error.details !== undefined) body.details = error.details;
      if (error.status >= 500) log.error("request failed", { method: request.method, url: request.url, error: error.message });
      return reply.code(error.status).send(body);
    }
    const e = error as { statusCode?: number; code?: string; message?: string };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
      const code = e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? "unsupported_media_type" : "invalid_request";
      return reply.code(e.statusCode).send({ error: code, message: e.message ?? "invalid request" });
    }
    log.error("unhandled error", { method: request.method, url: request.url, error: errorMessage(error) });
    return reply.code(500).send({ error: "internal", message: errorMessage(error) });
  });

  app.addHook("onClose", async () => {
    for (const controller of streams) controller.abort();
  });

  app.get("/api/health", async (): Promise<HealthResponse> => {
    const { database, openrouter_configured } = await scheduler.health();
    return { status: "ok", database, version: API_VERSION, openrouter_configured };
  });

  // Dots

  app.post("/api/dots", async (request, reply) => {
    const dot = await scheduler.createDot(bodyOf(request).config);
    return reply.code(201).send(dot);
  });

  app.get("/api/dots", async (): Promise<DotsAnswer> => ({ dots: await scheduler.listDots() }));

  app.get<{ Params: Params }>("/api/dots/:id", async (request) => scheduler.requireDot(request.params.id));

  app.patch<{ Params: Params }>("/api/dots/:id", async (request) =>
    scheduler.updateDot(request.params.id, bodyOf(request).config),
  );

  app.delete<{ Params: Params }>("/api/dots/:id", async (request, reply) => {
    return reply.code(202).send(await scheduler.deleteDot(request.params.id));
  });

  // Messages and tasks

  app.post<{ Params: Params }>("/api/dots/:id/messages", async (request, reply) => {
    const text = bodyOf(request).text;
    if (typeof text !== "string") throw bad("text must be a string");
    return reply.code(202).send(await scheduler.sendMessage(request.params.id, text));
  });

  app.get<{ Params: Params }>(
    "/api/dots/:id/messages",
    async (request): Promise<MessagesAnswer> => ({ messages: await scheduler.conversation(request.params.id) }),
  );

  app.post<{ Params: Params }>("/api/dots/:id/tasks", async (request, reply) => {
    const body = bodyOf(request);
    const task = await scheduler.createTask(request.params.id, {
      description: body.description as string,
      priority: body.priority as number | undefined,
      scheduled_at: body.scheduled_at as string | undefined,
    });
    return reply.code(201).send(task);
  });

  app.get<{ Params: Params }>(
    "/api/dots/:id/tasks",
    async (request): Promise<TasksAnswer> => ({ tasks: await scheduler.listTasks(request.params.id) }),
  );

  app.get<{ Params: Params }>("/api/tasks/:id", async (request) => scheduler.getTask(request.params.id));

  app.post<{ Params: Params }>("/api/tasks/:id/cancel", async (request) => scheduler.cancelTask(request.params.id));

  // Computer

  app.get<{ Params: Params }>("/api/dots/:id/computer", async (request) => scheduler.computer(request.params.id));

  const lifecycleRoute = (action: "start" | "stop" | "reboot") =>
    app.post<{ Params: Params }>(`/api/dots/:id/computer/${action}`, async (request, reply) => {
      const id = request.params.id;
      const answer =
        action === "start"
          ? await scheduler.startComputer(id)
          : action === "stop"
            ? await scheduler.stopComputer(id)
            : await scheduler.rebootComputer(id);
      return reply.code(202).send(answer);
    });
  lifecycleRoute("start");
  lifecycleRoute("stop");
  lifecycleRoute("reboot");

  app.get<{ Params: Params }>("/api/dots/:id/computer/screenshot", async (request, reply) => {
    const png = await scheduler.screenshot(request.params.id);
    return reply.code(200).header("content-type", "image/png").header("cache-control", "no-store").send(Buffer.from(png));
  });

  // Browser identities

  app.get<{ Params: Params }>(
    "/api/dots/:id/browser-identities",
    async (request): Promise<IdentitiesAnswer> => ({ identities: await scheduler.listIdentities(request.params.id) }),
  );

  app.post<{ Params: Params }>("/api/dots/:id/browser-identities", async (request, reply) => {
    const body = bodyOf(request);
    const identity = await scheduler.createIdentity(request.params.id, {
      name: body.name as string,
      proxy: body.proxy as string | undefined,
    });
    return reply.code(201).send(identity);
  });

  app.get<{ Params: Params }>("/api/dots/:id/browser-identities/:identityId", async (request) =>
    scheduler.getIdentity(request.params.id, request.params.identityId),
  );

  app.delete<{ Params: Params }>("/api/dots/:id/browser-identities/:identityId", async (request, reply) => {
    await scheduler.deleteIdentity(request.params.id, request.params.identityId);
    return reply.code(204).send();
  });

  // Channels (the hub never returns a credential, and no route here echoes one)

  app.get<{ Params: Params }>(
    "/api/dots/:id/channels",
    async (request): Promise<ChannelsAnswer> => ({ channels: await channels.list(request.params.id) }),
  );

  // Link the Dot to a Telegram bot, or give the linked one a new token (a revoked token is the only way back from needs_relink).
  app.put<{ Params: Params }>("/api/dots/:id/channels/telegram", async (request, reply): Promise<ChannelRecord> => {
    const token = bodyOf(request).token;
    if (typeof token !== "string" || token.trim() === "") throw bad("token must be the bot token from @BotFather");
    const credentials = { [TELEGRAM_TOKEN_SECRET]: token.trim() };
    const linked = (await channels.list(request.params.id)).some((channel) => channel.kind === "telegram");
    if (linked) return channels.setCredentials(request.params.id, "telegram", credentials);
    return reply.code(201).send(await channels.add(request.params.id, "telegram", { credentials }));
  });

  app.patch<{ Params: Params }>("/api/dots/:id/channels/:kind", async (request): Promise<ChannelRecord> => {
    const kind = channelKind(request.params.kind);
    const { settings, enabled } = bodyOf(request);
    if (settings === undefined && enabled === undefined) throw bad("give settings, enabled, or both");
    if (enabled !== undefined && typeof enabled !== "boolean") throw bad("enabled must be true or false");
    let record: ChannelRecord | undefined;
    if (settings !== undefined) record = await channels.setSettings(request.params.id, kind, settings);
    if (enabled !== undefined) record = await channels.setEnabled(request.params.id, kind, enabled);
    return record!;
  });

  app.delete<{ Params: Params }>("/api/dots/:id/channels/:kind", async (request, reply) => {
    await channels.remove(request.params.id, channelKind(request.params.kind));
    return reply.code(204).send();
  });

  app.post<{ Params: Params }>("/api/dots/:id/channels/:kind/pairing", async (request, reply): Promise<ChannelPairingAnswer> => {
    return reply.code(201).send(await channels.pair(request.params.id, channelKind(request.params.kind)));
  });

  app.delete<{ Params: Params }>("/api/dots/:id/channels/:kind/peers/:peer", async (request, reply) => {
    await channels.removePeer(request.params.id, channelKind(request.params.kind), request.params.peer);
    return reply.code(204).send();
  });

  // Approvals

  app.get<{ Querystring: { status?: string } }>("/api/approvals", async (request): Promise<ApprovalsAnswer> => {
    const status = request.query.status;
    if (status !== undefined && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
      throw bad(`status must be one of ${APPROVAL_STATUSES.join(", ")}`);
    }
    return { approvals: await scheduler.listApprovals(status as ApprovalStatus | undefined) };
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post<{ Params: Params }>(`/api/approvals/:id/${decision}`, async (request) => {
      const note = bodyOf(request).note;
      if (note !== undefined && typeof note !== "string") throw bad("note must be a string");
      return scheduler.resolveApproval(request.params.id, decision, note);
    });
  }

  // Events and usage

  app.get<{ Params: Params; Querystring: { since?: string } }>(
    "/api/dots/:id/usage",
    async (request): Promise<UsageAnswer> => scheduler.usage(request.params.id, sinceParam(request.query.since)),
  );

  app.get<{ Params: Params; Querystring: { after?: string; limit?: string } }>(
    "/api/dots/:id/events",
    async (request): Promise<EventsAnswer> => {
      const after = intParam(request.query.after, "after");
      const limit = intParam(request.query.limit, "limit", 1000);
      return { events: await scheduler.listEvents(request.params.id, after, limit) };
    },
  );

  app.get<{ Querystring: { dot_id?: string; after?: string } }>("/api/stream", async (request, reply) => {
    let dotId: string | undefined;
    if (request.query.dot_id) {
      const dot = await scheduler.db.dots.resolve(request.query.dot_id);
      if (!dot && !request.query.dot_id.includes("_")) throw new ControlPlaneError(404, "not_found", `Dot "${request.query.dot_id}" not found`);
      dotId = dot?.id ?? request.query.dot_id;
    }
    // EventSource sends the last id it saw when it reconnects; it wins over the query.
    const lastEventId = request.headers["last-event-id"];
    const after = intParam(typeof lastEventId === "string" ? lastEventId : request.query.after, "after");

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write(": connected\n\n");

    const controller = new AbortController();
    streams.add(controller);
    const heartbeat = setInterval(() => raw.write(": ping\n\n"), heartbeatMs);
    heartbeat.unref();
    raw.on("close", () => controller.abort());
    try {
      for await (const event of scheduler.events.stream(dotId === undefined ? {} : { dotId }, { after, signal: controller.signal })) {
        raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      // The client reconnects with its last id; tell it why the server hung up.
      const code = error instanceof StreamOverflowError ? "stream_overflow" : "stream_error";
      raw.write(`event: ${STREAM_ERROR_EVENT}\ndata: ${JSON.stringify({ error: code, message: errorMessage(error) })}\n\n`);
      log.warn("event stream closed with an error", { error: errorMessage(error) });
    } finally {
      clearInterval(heartbeat);
      streams.delete(controller);
      raw.end();
    }
  });

  // Secrets

  app.put("/api/secrets/openrouter", async (request) => {
    const body = bodyOf(request);
    return scheduler.setOpenRouterKey(body.value, body.dot_id);
  });

  return app;
}

export type { FastifyInstance, FastifyReply };
