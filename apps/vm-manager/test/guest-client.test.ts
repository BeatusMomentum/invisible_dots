import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { testSocketPath, type OutboundEvent } from "@invisible-dots/shared";
import { afterEach, describe, expect, it } from "vitest";
import { GuestClient, GuestRequestError } from "../src/index.js";

const TOKEN = "dot-token-123";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void): Promise<{ socket: string; seen: Seen[] }> {
  const socket = testSocketPath("guest");
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
      seen.push(entry);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized", message: "bad token" }));
        return;
      }
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server!.listen(socket, resolve));
  return { socket, seen };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function event(seq: number): OutboundEvent {
  return { seq, id: `evt_${seq}`, type: "memory.written", ts: "2026-10-02T10:00:00.000Z", data: { key: `k${seq}` } };
}

describe("GuestClient", () => {
  it("calls every dot-agentd route with the bearer token", async () => {
    const { socket, seen } = await serve((req, res) => {
      if (req.url === "/v1/system") return json(res, 200, { hostname: "h", uptime_s: 1, cpus: 2, mem_total_bytes: 1, mem_available_bytes: 1, disk_total_bytes: 1, disk_free_bytes: 1 });
      if (req.url === "/v1/exec") return json(res, 200, { exit_code: 0, stdout: "hi\n", stderr: "", timed_out: false });
      if (req.url!.startsWith("/v1/files/list")) return json(res, 200, { entries: [] });
      if (req.url!.startsWith("/v1/files") && req.method === "GET") return res.writeHead(200).end(Buffer.from([1, 2, 3]));
      if (req.url!.startsWith("/v1/files") && req.method === "PUT") return res.writeHead(204).end();
      if (req.url === "/v1/screenshot") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("PNG"));
      json(res, 404, { error: "not_found", message: req.url });
    });
    const client = new GuestClient(socket, TOKEN);
    expect((await client.system()).hostname).toBe("h");
    expect(await client.exec({ command: "echo hi", timeout_ms: 1000 })).toMatchObject({ exit_code: 0, stdout: "hi\n" });
    expect(await client.readFile("workspace/a b.txt")).toEqual(Buffer.from([1, 2, 3]));
    await client.writeFile("/home/dot/x&y", "content");
    expect(await client.listFiles(".")).toEqual({ entries: [] });
    expect((await client.screenshot()).toString()).toBe("PNG");

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /v1/system",
      "POST /v1/exec",
      "GET /v1/files?path=workspace%2Fa%20b.txt",
      "PUT /v1/files?path=%2Fhome%2Fdot%2Fx%26y",
      "GET /v1/files/list?path=.",
      "GET /v1/screenshot",
    ]);
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.parse(seen[1]!.body)).toEqual({ command: "echo hi", timeout_ms: 1000 });
    expect(seen[3]!.body).toBe("content");
  });

  it("calls the agent routes under /v1/agent", async () => {
    const { socket, seen } = await serve((req, res) => {
      switch (`${req.method} ${req.url}`) {
        case "POST /v1/agent/secrets":
        case "PUT /v1/agent/config":
        case "DELETE /v1/agent/browser-identities/shop-abc123":
        case "POST /v1/agent/prepare-sleep":
          return res.writeHead(204).end();
        case "POST /v1/agent/events":
          return json(res, 202, { accepted: true });
        case "GET /v1/agent/state":
          return json(res, 200, { state: "IDLE", current_task_id: null, pending_approval: null });
        case "GET /v1/agent/browser-identities":
          return json(res, 200, { identities: [] });
        case "POST /v1/agent/browser-identities":
          return json(res, 201, { id: "shop-abc123", name: "shop", createdAt: "x", lastUsedAt: null, status: "available", profilePath: "/p" });
        default:
          return json(res, 404, { error: "not_found", message: req.url });
      }
    });
    const client = new GuestClient(socket, TOKEN);
    await client.pushSecrets("sk-or-test");
    await client.putConfig({ name: "n" } as never);
    expect(await client.postEvent({ id: "e1", type: "user.message", ts: "2026-10-02T10:00:00Z", data: { text: "hi" } })).toEqual({ accepted: true });
    expect((await client.state()).state).toBe("IDLE");
    expect(await client.listBrowserIdentities()).toEqual({ identities: [] });
    expect((await client.createBrowserIdentity({ name: "shop" })).id).toBe("shop-abc123");
    await client.deleteBrowserIdentity("shop-abc123");
    await client.prepareSleep();
    expect(JSON.parse(seen[0]!.body)).toEqual({ openrouter_api_key: "sk-or-test" });
    expect(seen.map((s) => s.url)).toContain("/v1/agent/browser-identities/shop-abc123");
  });

  it("turns error bodies into GuestRequestError", async () => {
    const { socket } = await serve((_req, res) => json(res, 409, { error: "computer_busy", message: "try later" }));
    const error = await new GuestClient(socket, TOKEN).state().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestRequestError);
    expect(error).toMatchObject({ status: 409, code: "computer_busy" });
    expect((error as Error).message).toContain("computer_busy: try later");

    const unauthorized = await new GuestClient(socket, "wrong").health().catch((e: unknown) => e);
    expect(unauthorized).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("streams events, reconnecting with ?after= and never repeating one", async () => {
    let connection = 0;
    const { socket, seen } = await serve((req, res) => {
      connection++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (connection === 1) {
        // Two events, then the connection drops mid-message.
        res.write(`: hello\n\nid: 1\ndata: ${JSON.stringify(event(1))}\n\n`);
        res.write(`id: 2\r\ndata: ${JSON.stringify(event(2))}\r\n\r\n`);
        res.end(`id: 3\ndata: {"seq":3`);
      } else {
        const after = Number(new URL(req.url!, "http://x").searchParams.get("after"));
        // A server replaying one too many must not produce a duplicate.
        for (let seq = after; seq <= after + 2; seq++) res.write(`id: ${seq}\ndata: ${JSON.stringify(event(seq))}\n\n`);
      }
    });
    const client = new GuestClient(socket, TOKEN);
    const controller = new AbortController();
    const got: number[] = [];
    const reconnects: number[] = [];
    for await (const evt of client.events({ signal: controller.signal, reconnectDelayMs: 10, onReconnect: (info) => reconnects.push(info.after) })) {
      got.push(evt.seq);
      if (got.length === 4) controller.abort();
    }
    expect(got).toEqual([1, 2, 3, 4]);
    expect(reconnects).toEqual([2]);
    expect(seen.map((s) => s.url)).toEqual(["/v1/agent/events/stream?after=0", "/v1/agent/events/stream?after=2"]);
  });

  it("resumes from the given cursor and stops when the consumer breaks", async () => {
    const { socket, seen } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 8\ndata: ${JSON.stringify(event(8))}\n\n`);
    });
    for await (const evt of new GuestClient(socket, TOKEN).events({ after: 7 })) {
      expect(evt.seq).toBe(8);
      break;
    }
    expect(seen[0]!.url).toBe("/v1/agent/events/stream?after=7");
  });

  it("does not retry the stream on a refused token", async () => {
    const { socket } = await serve(() => {});
    const stream = new GuestClient(socket, "wrong").events({ reconnectDelayMs: 1 });
    await expect(stream.next()).rejects.toMatchObject({ status: 401 });
  });
});
