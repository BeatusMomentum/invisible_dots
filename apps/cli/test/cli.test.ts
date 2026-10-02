import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXIT, run, SAMPLE_DOT, type CliIo } from "../src/index.js";

const TOKEN = "cli-test-token-0123456789";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const now = "2026-10-02T08:00:00.000Z";
const dot = {
  id: "dot_01abc",
  name: "fare-watch",
  config: {
    name: "fare-watch",
    goal: "Check fares",
    model: { provider: "openrouter", id: "test/model" },
    computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" },
  },
  status: "READY",
  error: null,
  created_at: now,
  updated_at: now,
  computer_state: "RUNNING",
};
const computer = {
  dot_id: dot.id,
  domain_name: "invisible-dot-dot_01abc",
  cid: 10000,
  state: "RUNNING",
  golden_image: null,
  runtime_image: null,
  event_cursor: 3,
  last_active_at: now,
  last_error: null,
  updated_at: now,
  ready: true,
};
const task = {
  id: "task_01",
  dot_id: dot.id,
  description: "find the cheapest day",
  priority: 0,
  status: "COMPLETED",
  created_at: now,
  scheduled_at: null,
  started_at: now,
  finished_at: now,
  summary: "tuesday",
  error: null,
};
const events = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  dot_id: dot.id,
  type: i % 2 ? "agent.state" : "memory.written",
  data: i % 2 ? { state: "IDLE", guest_event_id: "x", guest_ts: now } : { key: `k${i}` },
  source: "guest",
  guest_seq: i + 1,
  created_at: now,
}));

let server: Server;
let base: string;
const requests: Recorded[] = [];
let stopped = false;

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const body = text ? JSON.parse(text) : undefined;
  requests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, body });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized", message: "bad token" });
  const route = `${req.method} ${url.pathname}`;
  const byName = (p: string) => p.replace("/fare-watch", `/${dot.id}`);
  switch (byName(route)) {
    case "GET /api/health":
      return send(res, 200, { status: "ok", database: "ok", version: "9.9.9" });
    case "POST /api/dots":
      if (typeof body?.config === "string" && body.config.includes("Bad Name")) {
        return send(res, 400, {
          error: "invalid_config",
          message: "invalid Dot configuration: name: must be lowercase",
          details: [{ path: "name", message: "must be lowercase" }],
        });
      }
      return send(res, 201, { ...dot, status: "CREATING" });
    case "GET /api/dots":
      return send(res, 200, { dots: [dot] });
    case `GET /api/dots/${dot.id}`:
      return send(res, 200, dot);
    case `GET /api/dots/${dot.id}/computer`:
      return send(res, 200, computer);
    case `GET /api/dots/${dot.id}/tasks`:
      return send(res, 200, { tasks: [task] });
    case `POST /api/dots/${dot.id}/tasks`:
      return send(res, 201, { ...task, id: "task_02", status: "PENDING", description: body.description });
    case `POST /api/dots/${dot.id}/messages`:
      return send(res, 202, { message_id: "msg_1", event_id: 9, delivery: "queued" });
    case `POST /api/dots/${dot.id}/computer/start`:
    case `POST /api/dots/${dot.id}/computer/stop`:
    case `POST /api/dots/${dot.id}/computer/reboot`:
      return send(res, 202, { accepted: true });
    case `GET /api/dots/${dot.id}/browser-identities`:
      if (stopped) return send(res, 409, { error: "computer_stopped", message: "the computer of Dot fare-watch is STOPPED; start it first" });
      return send(res, 200, {
        identities: [{ id: "shop-abc123", name: "Shop", createdAt: now, lastUsedAt: null, status: "available", profilePath: "/p" }],
      });
    case "GET /api/approvals":
      return send(res, 200, {
        approvals: [{ id: "apr_1", dot_id: dot.id, task_id: null, tool: "browser_identity_delete", permission: "browser.identity.delete", arguments: {}, reason: "cleanup", status: "pending", note: null, created_at: now, resolved_at: null }],
      });
    case "POST /api/approvals/apr_1/approve":
      return send(res, 200, { id: "apr_1", status: "approved", note: body?.note ?? null });
    case "POST /api/approvals/apr_1/reject":
      return send(res, 200, { id: "apr_1", status: "rejected", note: body?.note ?? null });
    case "PUT /api/secrets/openrouter":
      return send(res, 200, { pushed: 2 });
    case `GET /api/dots/${dot.id}/events`: {
      const after = Number(url.searchParams.get("after") ?? 0);
      return send(res, 200, { events: events.filter((e) => e.id > after) });
    }
    case "GET /api/stream": {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const after = Number(url.searchParams.get("after") ?? 0);
      res.write(": connected\n\n");
      const live = { ...events[0]!, id: after + 1, type: "task.completed", data: { task_id: "task_02", summary: "done" } };
      res.write(`id: ${live.id}\ndata: ${JSON.stringify(live)}\n\n`);
      return; // left open, like the real stream
    }
    default:
      return send(res, 404, { error: "not_found", message: `no route ${route}` });
  }
}

let configDir: string;

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configDir = await mkdtemp(join(tmpdir(), "idots-cli-"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  stopped = false;
});

async function cli(argv: string[], options: { env?: Record<string, string>; stdin?: string; tty?: boolean; signal?: AbortSignal } = {}) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: async () => options.stdin ?? "",
    stdinIsTTY: options.tty ?? false,
    env: { INVISIBLE_DOTS_URL: base, INVISIBLE_DOTS_TOKEN: TOKEN, INVISIBLE_DOTS_CONFIG_DIR: configDir, ...options.env },
    cwd: configDir,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

describe("usage", () => {
  it("prints help with exit 0, and exit 2 with no command, an unknown command or an unknown flag", async () => {
    expect((await cli(["--help"])).code).toBe(EXIT.ok);
    const none = await cli([]);
    expect(none.code).toBe(EXIT.usage);
    expect(none.stdout).toContain("Usage:");
    expect((await cli(["launch"])).stderr).toMatch(/unknown command "launch"/);
    expect((await cli(["list", "--bogus"])).code).toBe(EXIT.usage);
    expect((await cli(["status"])).stderr).toMatch(/missing <dot>/);
    expect((await cli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe("server and token", () => {
  it("reads the token from api.token in the config dir when INVISIBLE_DOTS_TOKEN is unset", async () => {
    await writeFile(join(configDir, "api.token"), `${TOKEN}\n`);
    const result = await cli(["list"], { env: { INVISIBLE_DOTS_TOKEN: "" } });
    expect(result.code).toBe(EXIT.ok);
    await rm(join(configDir, "api.token"));
  });

  it("exit 4 without a token or with a refused one, exit 3 when the server is unreachable", async () => {
    const missing = await cli(["list"], { env: { INVISIBLE_DOTS_TOKEN: "", INVISIBLE_DOTS_CONFIG_DIR: join(configDir, "none") } });
    expect(missing.code).toBe(EXIT.auth);
    expect(missing.stderr).toMatch(/no API token/);
    const refused = await cli(["list"], { env: { INVISIBLE_DOTS_TOKEN: "wrong-token-123456789" } });
    expect(refused.code).toBe(EXIT.auth);
    expect(refused.stderr).toMatch(/refused the API token/);
    const down = await cli(["list"], { env: { INVISIBLE_DOTS_URL: "http://127.0.0.1:1" } });
    expect(down.code).toBe(EXIT.unreachable);
    expect(down.stderr).toMatch(/cannot reach the invisible_dots API/);
  });
});

describe("commands", () => {
  it("init writes the sample, checks the server and refuses to overwrite without --force", async () => {
    const first = await cli(["init", "sample.yaml"]);
    expect(first.code).toBe(EXIT.ok);
    expect(first.stdout).toMatch(/is reachable \(version 9\.9\.9/);
    expect(await readFile(join(configDir, "sample.yaml"), "utf8")).toBe(SAMPLE_DOT);
    const again = await cli(["init", "sample.yaml"]);
    expect(again.code).toBe(EXIT.failed);
    expect(again.stderr).toMatch(/already exists/);
    expect((await cli(["init", "sample.yaml", "--force"])).code).toBe(EXIT.ok);
  });

  it("create sends the YAML text and prints validation details on 400", async () => {
    await writeFile(join(configDir, "good.yaml"), SAMPLE_DOT);
    const ok = await cli(["create", "good.yaml"]);
    expect(ok.code).toBe(EXIT.ok);
    expect(ok.stdout).toMatch(/created Dot fare-watch/);
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({ config: SAMPLE_DOT });

    await writeFile(join(configDir, "bad.yaml"), "name: Bad Name\n");
    const bad = await cli(["create", "bad.yaml"]);
    expect(bad.code).toBe(EXIT.failed);
    expect(bad.stderr).toMatch(/\[400 invalid_config\]/);
    expect(bad.stderr).toMatch(/name: must be lowercase/);
    expect((await cli(["create", "missing.yaml"])).code).toBe(EXIT.usage);
  });

  it("list, status and tasks print tables, and --json prints the data", async () => {
    const list = await cli(["list"]);
    expect(list.stdout).toMatch(/^NAME\s+STATUS\s+COMPUTER/);
    expect(list.stdout).toContain("fare-watch  READY");
    const json = await cli(["list", "--json"]);
    expect(JSON.parse(json.stdout)[0].id).toBe(dot.id);
    const status = await cli(["status", "fare-watch"]);
    expect(status.code).toBe(EXIT.ok);
    expect(status.stdout).toMatch(/computer\s+RUNNING, ready/);
    expect(status.stdout).toContain("task_01");
    expect((await cli(["tasks", "fare-watch"])).stdout).toContain("COMPLETED");
  });

  it("message and task send what was typed", async () => {
    const message = await cli(["message", "fare-watch", "how", "is", "it", "going?"]);
    expect(message.stdout).toMatch(/message queued/);
    expect(requests.at(-1)?.body).toEqual({ text: "how is it going?" });
    const queued = await cli(["task", "fare-watch", "check", "Lisbon", "--priority", "3", "--at", "2030-01-01T08:00:00Z"]);
    expect(queued.code).toBe(EXIT.ok);
    expect(requests.at(-1)?.body).toEqual({ description: "check Lisbon", priority: 3, scheduled_at: "2030-01-01T08:00:00.000Z" });
    expect((await cli(["task", "fare-watch", "x", "--priority", "high"])).code).toBe(EXIT.usage);
    expect((await cli(["message", "fare-watch"])).code).toBe(EXIT.usage);
  });

  it("computer actions, and browser identities with the server's 409 shown", async () => {
    for (const action of ["start", "stop", "reboot"]) {
      expect((await cli(["computer", "fare-watch", action])).code).toBe(EXIT.ok);
      expect(requests.at(-1)?.path).toBe(`/api/dots/fare-watch/computer/${action}`);
    }
    expect((await cli(["computer", "fare-watch", "pause"])).code).toBe(EXIT.usage);
    expect((await cli(["browser", "fare-watch", "identities"])).stdout).toContain("shop-abc123");
    stopped = true;
    const conflict = await cli(["browser", "fare-watch", "identities"]);
    expect(conflict.code).toBe(EXIT.failed);
    expect(conflict.stderr).toMatch(/start it first \[409 computer_stopped\]/);
  });

  it("approvals, approve and reject", async () => {
    expect((await cli(["approvals"])).stdout).toContain("apr_1");
    expect(requests.at(-1)?.query.get("status")).toBe("pending");
    await cli(["approvals", "--all"]);
    expect(requests.at(-1)?.query.get("status")).toBeNull();
    const approved = await cli(["approve", "apr_1", "--note", "fine"]);
    expect(approved.stdout).toBe("approval apr_1 approved\n");
    expect(requests.at(-1)?.body).toEqual({ note: "fine" });
    expect((await cli(["reject", "apr_1"])).stdout).toBe("approval apr_1 rejected\n");
  });

  it("secret openrouter reads the key from stdin only", async () => {
    const stored = await cli(["secret", "openrouter"], { stdin: "sk-or-v1-abc\n" });
    expect(stored.code).toBe(EXIT.ok);
    expect(stored.stdout).toMatch(/pushed to 2 running Dots/);
    expect(requests.at(-1)?.body).toEqual({ value: "sk-or-v1-abc" });
    await cli(["secret", "openrouter", "--dot", "fare-watch"], { stdin: "sk-or-v1-abc" });
    expect(requests.at(-1)?.body).toEqual({ value: "sk-or-v1-abc", dot_id: "fare-watch" });
    const inArgs = await cli(["secret", "openrouter", "sk-or-v1-abc"]);
    expect(inArgs.code).toBe(EXIT.usage);
    expect(inArgs.stderr).toMatch(/never from arguments/);
    expect((await cli(["secret", "openrouter"], { stdin: "  " })).code).toBe(EXIT.usage);
  });

  it("logs prints the tail without follow, and follows the stream until interrupted", async () => {
    const tail = await cli(["logs", "fare-watch", "--tail", "2", "--no-follow"]);
    expect(tail.code).toBe(EXIT.ok);
    const lines = tail.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/#4 agent\.state \{"state":"IDLE"\}$/);

    const controller = new AbortController();
    let output = "";
    const io: CliIo = {
      stdout: (t) => {
        output += t;
        if (t.includes("task.completed")) controller.abort();
      },
      stderr: () => {},
      readStdin: async () => "",
      stdinIsTTY: false,
      env: { INVISIBLE_DOTS_URL: base, INVISIBLE_DOTS_TOKEN: TOKEN },
      cwd: configDir,
      signal: controller.signal,
    };
    expect(await run(["logs", "fare-watch", "--tail", "1"], io)).toBe(EXIT.ok);
    expect(output).toMatch(/#5 memory\.written/);
    expect(output).toMatch(/#6 task\.completed/);
    const stream = requests.find((r) => r.path === "/api/stream");
    expect(stream?.query.get("after")).toBe("5");
    expect(stream?.query.get("dot_id")).toBe(dot.id);
  });
});
