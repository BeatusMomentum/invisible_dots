import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpOverSocket, offeredTools, testSocketPath, type OutboundEvent } from "@invisible-dots/shared";
import type { ToolRegistry } from "@invisible-dots/agent-runtime";
import { completion, startFakeOpenRouter, type FakeOpenRouter } from "../../../guest-runtime/openrouter-client/test/fake-openrouter.js";
import { createAgent, createJsonLogger, type Agent } from "../src/index.js";

const config = {
  name: "web-dot",
  goal: "Answer questions.",
  model: { provider: "openrouter", id: "test/model" },
  browser: { identities: { max_identities: 2, max_open: 1 } },
};

const registry: ToolRegistry = {
  definitions: (c) => offeredTools(c),
  call: async (name) => ({ ok: true, text: `${name} ran` }),
};

let dir: string;
let socket: string;
let fake: FakeOpenRouter;
let agent: Agent;
let logLines: string[];

async function boot(): Promise<void> {
  agent = createAgent({
    listen: { socketPath: socket },
    dbPath: join(dir, "state", "dot.db"),
    browsersDir: join(dir, "browsers"),
    agentdSocket: join(dir, "agentd.sock"),
    mcpCommand: ["invisible-playwright-mcp"],
    logger: createJsonLogger({ level: "debug", write: (line) => logLines.push(line) }),
    openrouterUrl: fake.url,
    registry,
    checks: async () => ({ filesystem_writable: true, network_reachable: true, browser_installed: false }),
  });
  await agent.start();
}

async function call(method: string, path: string, body?: unknown) {
  const res = await httpOverSocket(socket, {
    method,
    path,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
    timeoutMs: 5000,
  });
  const text = res.body.toString("utf8");
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "idots-agent-http-"));
  socket = testSocketPath("agent");
  fake = await startFakeOpenRouter();
  logLines = [];
  await boot();
});

afterEach(async () => {
  await agent.shutdown();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

interface StreamClient {
  events: OutboundEvent[];
  ids: string[];
  waitFor(count: number): Promise<void>;
  close(): void;
}

function openStream(path: string, headers: Record<string, string> = {}): Promise<StreamClient> {
  return new Promise((resolve, reject) => {
    const events: OutboundEvent[] = [];
    const ids: string[] = [];
    const waiters: { count: number; resolve: () => void }[] = [];
    let buffer = "";
    const req = request({ socketPath: socket, path, headers: { host: "localhost", ...headers }, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`stream answered ${res.statusCode}`));
        return;
      }
      expect(res.headers["content-type"]).toContain("text/event-stream");
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) ids.push(line.slice(4));
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) events.push(JSON.parse(data) as OutboundEvent);
        }
        for (const w of waiters.splice(0)) {
          if (events.length >= w.count) w.resolve();
          else waiters.push(w);
        }
      });
      resolve({
        events,
        ids,
        waitFor: (count) =>
          events.length >= count
            ? Promise.resolve()
            : new Promise<void>((done, fail) => {
                const timer = setTimeout(() => fail(new Error(`only ${events.length} of ${count} events arrived`)), 5000);
                waiters.push({
                  count,
                  resolve: () => {
                    clearTimeout(timer);
                    done();
                  },
                });
              }),
        close: () => req.destroy(),
      });
    });
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.end();
  });
}

describe("agent HTTP API", () => {
  it("reports health, and becomes configured once the key is pushed", async () => {
    const before = await call("GET", "/health");
    expect(before.status).toBe(200);
    expect(before.json).toEqual({
      status: "ok",
      state: "IDLE",
      openrouter_configured: false,
      browser: { identities: 0, open: 0 },
      checks: { filesystem_writable: true, network_reachable: true, browser_installed: false },
    });

    expect((await call("POST", "/secrets", { openrouter_api_key: "" })).status).toBe(400);
    expect((await call("POST", "/secrets", "{not json sk-secret-in-a-bad-body")).json).toEqual({
      error: "invalid_json",
      message: "the body is not valid JSON",
    });
    expect((await call("POST", "/secrets", { openrouter_api_key: "sk-or-very-secret" })).status).toBe(204);
    expect((await call("GET", "/health")).json!.openrouter_configured).toBe(true);
    const log = logLines.join("");
    expect(log).toContain("OpenRouter key received");
    expect(log).not.toContain("very-secret");
    expect(log).not.toContain("sk-secret-in-a-bad-body");
  });

  it("validates and persists PUT /config", async () => {
    const bad = await call("PUT", "/config", { ...config, name: "Bad Name" });
    expect(bad.status).toBe(400);
    expect(bad.json!.error).toBe("invalid_config");
    expect(bad.json!.message).toContain("name");
    const withComputer = await call("PUT", "/config", { ...config, computer: { cpu: 2 } });
    expect(withComputer.status).toBe(400);
    expect((await call("PUT", "/config", config)).status).toBe(204);
    expect(agent.runtime.config!.name).toBe("web-dot");
    expect(agent.identities.limits).toEqual({ maxOpen: 1, maxIdentities: 2 });
  });

  it("accepts inbound events and answers a chat turn", async () => {
    await call("PUT", "/config", config);
    await call("POST", "/secrets", { openrouter_api_key: "k" });
    fake.push(completion({ content: "hello from the VM" }));

    const invalid = await call("POST", "/events", { id: "e1", type: "user.message", ts: "yesterday", data: { text: "hi" } });
    expect(invalid.status).toBe(400);
    expect(invalid.json!.error).toBe("invalid_event");

    const event = { id: "evt-1", type: "user.message", ts: new Date().toISOString(), data: { text: "hi" } };
    const accepted = await call("POST", "/events", event);
    expect(accepted).toEqual({ status: 202, json: { accepted: true } });
    expect(await call("POST", "/events", event)).toEqual({ status: 202, json: { accepted: true } });
    await agent.runtime.idle();
    const answers = agent.store.readAfter(0).filter((e) => e.type === "message.assistant");
    expect(answers.map((e) => e.data)).toEqual([{ text: "hello from the VM", in_reply_to: "evt-1" }]);
    expect((await call("GET", "/state")).json).toEqual({ state: "IDLE", current_task_id: null, pending_approval: null });
  });

  it("manages browser identities through the browser manager", async () => {
    await call("PUT", "/config", config);
    const created = await call("POST", "/browser-identities", { name: "Shop account" });
    expect(created.status).toBe(201);
    const id = created.json!.id as string;
    expect(id).toMatch(/^shop-account-[a-z0-9]{6}$/);
    expect(created.json).toMatchObject({ name: "Shop account", status: "available", lastUsedAt: null });

    expect((await call("GET", "/browser-identities")).json!.identities).toHaveLength(1);
    expect((await call("GET", `/browser-identities/${id}`)).json!.id).toBe(id);
    expect((await call("GET", "/health")).json!.browser).toEqual({ identities: 1, open: 0 });
    expect(agent.store.getIdentity(id)?.name).toBe("Shop account");

    expect((await call("POST", "/browser-identities", { name: "" })).status).toBe(400);
    expect((await call("POST", "/browser-identities", { name: "p", proxy: "ftp://x" })).status).toBe(400);
    await call("POST", "/browser-identities", { name: "Second" });
    const third = await call("POST", "/browser-identities", { name: "Third" });
    expect(third.status).toBe(409);
    expect(third.json!.error).toBe("limit");

    expect((await call("GET", "/browser-identities/nope-123456")).status).toBe(404);
    expect((await call("DELETE", "/browser-identities/nope-123456")).status).toBe(404);
    expect((await call("DELETE", `/browser-identities/${id}`)).status).toBe(204);
    expect((await call("GET", `/browser-identities/${id}`)).status).toBe(404);

    const types = agent.store.readAfter(0).map((e) => e.type);
    expect(types.filter((t) => t === "browser.identity.created")).toHaveLength(2);
    expect(types.filter((t) => t === "browser.identity.deleted")).toHaveLength(1);
  });

  it("streams the outbox: replay after a seq, then live events", async () => {
    agent.store.appendEvent("memory.written", { key: "a" });
    agent.store.appendEvent("memory.written", { key: "b" });
    const first = agent.store.readAfter(0)[0]!.seq;

    const stream = await openStream(`/events/stream?after=${first}`);
    const replayed = agent.store.lastSeq() - first;
    await stream.waitFor(replayed);
    agent.store.appendEvent("memory.written", { key: "live" });
    await stream.waitFor(replayed + 1);
    stream.close();

    const seqs = stream.events.map((e) => e.seq);
    expect(seqs).toEqual(agent.store.readAfter(first).map((e) => e.seq));
    expect(stream.ids).toEqual(seqs.map(String));
    expect(stream.events.at(-1)).toMatchObject({ type: "memory.written", data: { key: "live" } });
    expect(seqs[0]).toBe(first + 1);
  });

  it("resumes a stream from Last-Event-ID and refuses a bad cursor", async () => {
    agent.store.appendEvent("memory.written", { key: "x" });
    const last = agent.store.lastSeq();
    const stream = await openStream("/events/stream", { "last-event-id": String(last - 1) });
    await stream.waitFor(1);
    expect(stream.events[0]!.seq).toBe(last);
    stream.close();
    expect((await call("GET", "/events/stream?after=-1")).status).toBe(400);
  });

  it("prepares to sleep and keeps the outbox after a restart", async () => {
    expect((await call("POST", "/prepare-sleep")).status).toBe(204);
    const lastSeq = agent.store.lastSeq();
    await agent.shutdown();
    await boot();
    const stream = await openStream(`/events/stream?after=${lastSeq}`);
    await stream.waitFor(1);
    expect(stream.events[0]).toMatchObject({ seq: lastSeq + 1, type: "agent.state" });
    stream.close();
  });

  it("answers 404 and 405 with the error shape", async () => {
    expect(await call("GET", "/nope")).toEqual({ status: 404, json: { error: "not_found", message: "no route GET /nope" } });
    const wrong = await call("DELETE", "/health");
    expect(wrong.status).toBe(405);
    expect(wrong.json!.error).toBe("method_not_allowed");
  });
});
