import { createServer, type IncomingMessage, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { socketIsAFile, testSocketPath } from "@invisible-dots/shared";
import { AgentdError, SocketAgentdClient } from "../src/index.js";

interface Seen {
  method: string;
  url: string;
  contentType: string | undefined;
  body: Buffer;
}

let server: Server;
let socketPath: string;
let seen: Seen[];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

beforeEach(async () => {
  seen = [];
  socketPath = testSocketPath("agentd");
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method!, url: req.url!, contentType: req.headers["content-type"], body });
    const url = new URL(req.url!, "http://agentd");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && url.pathname === "/v1/exec") {
      const request = JSON.parse(body.toString("utf8"));
      return json(200, { exit_code: 0, stdout: `ran ${request.command}`, stderr: "", timed_out: false });
    }
    if (url.pathname === "/v1/files" && req.method === "GET") {
      if (url.searchParams.get("path") === "missing.txt") return json(404, { error: "not_found", message: "no such file: missing.txt" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    }
    if (url.pathname === "/v1/files" && req.method === "PUT") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/v1/files/list") {
      return json(200, { entries: [{ name: "a.txt", type: "file", size: 3, mtime: "2026-01-01T00:00:00Z" }] });
    }
    if (url.pathname === "/v1/screenshot") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from("png-bytes"));
    }
    if (url.pathname === "/v1/health") return json(200, { agentd: "ok", agent: { status: "down" }, uptime_s: 5 });
    if (url.pathname === "/v1/system") {
      res.writeHead(500);
      return res.end("disk probe failed");
    }
    json(404, { error: "not_found", message: "no route" });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (socketIsAFile(socketPath)) await rm(socketPath, { force: true });
});

describe("SocketAgentdClient", () => {
  it("posts exec as JSON and parses the answer", async () => {
    const client = new SocketAgentdClient({ socketPath });
    const answer = await client.exec({ command: "ls -la", cwd: "workspace", timeout_ms: 5000 });
    expect(answer).toEqual({ exit_code: 0, stdout: "ran ls -la", stderr: "", timed_out: false });
    expect(seen[0]!.contentType).toBe("application/json");
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ command: "ls -la", cwd: "workspace", timeout_ms: 5000 });
  });

  it("encodes file paths in the query and moves raw bytes both ways", async () => {
    const client = new SocketAgentdClient({ socketPath });
    const bytes = await client.readFile("workspace/a b&c.txt");
    expect([...bytes]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(seen[0]!.url).toBe("/v1/files?path=workspace%2Fa%20b%26c.txt");

    await client.writeFile("/home/dot/x.txt", "hello");
    expect(seen[1]!.method).toBe("PUT");
    expect(seen[1]!.body.toString()).toBe("hello");

    const list = await client.listFiles("workspace");
    expect(list.entries[0]!.name).toBe("a.txt");
    expect(seen[2]!.url).toBe("/v1/files/list?path=workspace");

    expect((await client.screenshot()).toString()).toBe("png-bytes");
    expect((await client.health()).agentd).toBe("ok");
  });

  it("turns error answers into AgentdError with the agentd code and message", async () => {
    const client = new SocketAgentdClient({ socketPath });
    const error = await client.readFile("missing.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentdError);
    expect((error as AgentdError).status).toBe(404);
    expect((error as AgentdError).code).toBe("not_found");
    expect((error as AgentdError).message).toContain("no such file: missing.txt");

    await expect(client.system()).rejects.toThrow(/answered 500 http_500: disk probe failed/);
  });

  it("explains a socket nobody listens on", async () => {
    const client = new SocketAgentdClient({ socketPath: testSocketPath("nobody") });
    await expect(client.health()).rejects.toThrow(/GET \/v1\/health over .* failed/);
  });
});
