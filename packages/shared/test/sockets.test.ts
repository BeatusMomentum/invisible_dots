import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { httpOverSocket, SocketRequestError, testSocketPath } from "../src/index.js";

const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const path = testSocketPath("shared");
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return path;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("testSocketPath", () => {
  it("is unique and platform appropriate", () => {
    const a = testSocketPath("x y");
    expect(a).not.toBe(testSocketPath("x y"));
    if (process.platform === "win32") expect(a.startsWith("\\\\.\\pipe\\")).toBe(true);
    else expect(a.endsWith(".sock")).toBe(true);
    expect(a).not.toContain(" ");
  });
});

describe("httpOverSocket", () => {
  it("sends method, path, headers and body and buffers the answer", async () => {
    const path = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json", "x-echo": req.headers.authorization ?? "" });
        res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    const answer = await httpOverSocket(path, {
      method: "post",
      path: "/v1/exec?x=1",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ command: "true" }),
    });
    expect(answer.status).toBe(201);
    expect(answer.headers["x-echo"]).toBe("Bearer test-token");
    expect(JSON.parse(answer.body.toString("utf8"))).toEqual({
      method: "POST",
      url: "/v1/exec?x=1",
      body: '{"command":"true"}',
    });
  });

  it("returns binary bodies untouched", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    const path = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    });
    const answer = await httpOverSocket(path, { path: "/v1/screenshot" });
    expect(answer.body.equals(png)).toBe(true);
  });

  it("explains a missing socket", async () => {
    const error = await httpOverSocket(testSocketPath("missing"), { path: "/v1/health" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocketRequestError);
    expect((error as Error).message).toMatch(/GET \/v1\/health over .* failed/);
  });

  it("times out", async () => {
    const path = await serve(() => {
      // never answers
    });
    const error = await httpOverSocket(path, { path: "/slow", timeoutMs: 100 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocketRequestError);
    expect((error as SocketRequestError).code).toBe("ETIMEDOUT");
  });

  it("can be aborted", async () => {
    const path = await serve(() => {
      // never answers
    });
    const controller = new AbortController();
    const pending = httpOverSocket(path, { path: "/slow", signal: controller.signal }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 50);
    const error = await pending;
    expect((error as SocketRequestError).code).toBe("ABORT_ERR");
  });
});
