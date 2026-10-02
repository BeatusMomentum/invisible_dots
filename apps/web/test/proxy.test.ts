import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { InvisibleDotsClient } from "@invisible-dots/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET, POST } from "../src/app/api/[...path]/route";
import {
  ProxyError,
  apiBaseUrl,
  checkRequestOrigin,
  forwardRequestHeaders,
  forwardResponseHeaders,
  loadApiToken,
  upstreamUrl,
} from "../src/lib/proxy";

describe("upstreamUrl", () => {
  it("maps proxy segments under /api and keeps the query", () => {
    expect(upstreamUrl("http://h:1", ["dots", "a b", "tasks"], "?x=1")).toBe("http://h:1/api/dots/a%20b/tasks?x=1");
  });

  it("re-encodes a decoded slash so it cannot add a path level", () => {
    expect(upstreamUrl("http://h:1", ["dots", "a/b"], "")).toBe("http://h:1/api/dots/a%2Fb");
  });

  it("refuses dot segments and empty paths", () => {
    expect(() => upstreamUrl("http://h:1", ["..", "health"], "")).toThrow(ProxyError);
    expect(() => upstreamUrl("http://h:1", ["dots", "."], "")).toThrow(ProxyError);
    expect(() => upstreamUrl("http://h:1", [], "")).toThrow(ProxyError);
  });
});

describe("apiBaseUrl", () => {
  it("defaults to the contract's listen address and trims a trailing slash", () => {
    expect(apiBaseUrl({})).toBe("http://127.0.0.1:8787");
    expect(apiBaseUrl({ INVISIBLE_DOTS_URL: "http://10.0.0.2:9000/" })).toBe("http://10.0.0.2:9000");
  });
});

describe("loadApiToken", () => {
  it("prefers INVISIBLE_DOTS_TOKEN", async () => {
    const read = async () => {
      throw new Error("must not read");
    };
    expect(await loadApiToken({ INVISIBLE_DOTS_TOKEN: " abc \n" }, read)).toBe("abc");
  });

  it("reads api.token from the config directory", async () => {
    const seen: string[] = [];
    const token = await loadApiToken({ INVISIBLE_DOTS_CONFIG_DIR: "/srv/idots" }, async (path) => {
      seen.push(path);
      return "from-file\n";
    });
    expect(token).toBe("from-file");
    expect(seen).toEqual(["/srv/idots/api.token"]);
  });

  it("explains a missing or empty token file", async () => {
    const missing = async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    };
    await expect(loadApiToken({}, missing)).rejects.toMatchObject({ status: 500, code: "web_token_missing" });
    await expect(loadApiToken({}, missing)).rejects.toThrow("/etc/invisible-dots/api.token readable (ENOENT)");
    await expect(loadApiToken({}, async () => "  \n")).rejects.toMatchObject({ code: "web_token_missing" });
  });
});

describe("checkRequestOrigin", () => {
  const base = { method: "GET", host: "127.0.0.1:3000", origin: null, secFetchSite: null };

  it("lets loopback hosts through", () => {
    expect(checkRequestOrigin(base, {})).toBeNull();
    expect(checkRequestOrigin({ ...base, host: "localhost:3000" }, {})).toBeNull();
    expect(checkRequestOrigin({ ...base, host: "[::1]:3000" }, {})).toBeNull();
  });

  it("refuses other host names unless allowed, which stops DNS rebinding", () => {
    expect(checkRequestOrigin({ ...base, host: "evil.example:3000" }, {})).toMatch(/not allowed/);
    expect(
      checkRequestOrigin({ ...base, host: "dots.lan:3000" }, { INVISIBLE_DOTS_WEB_ALLOWED_HOSTS: "other, dots.lan" }),
    ).toBeNull();
  });

  it("refuses cross-site requests and foreign origins on writes", () => {
    expect(checkRequestOrigin({ ...base, secFetchSite: "cross-site" }, {})).toMatch(/cross-site/);
    expect(checkRequestOrigin({ ...base, method: "POST", origin: "http://evil.example" }, {})).toMatch(/does not match/);
    expect(checkRequestOrigin({ ...base, method: "POST", origin: "http://127.0.0.1:3000" }, {})).toBeNull();
  });
});

describe("header forwarding", () => {
  it("drops browser credentials and adds the bearer token", () => {
    const out = forwardRequestHeaders(
      new Headers({ cookie: "a=b", authorization: "Bearer stolen", "content-type": "application/json", "last-event-id": "9" }),
      "tok",
    );
    expect(out.get("cookie")).toBeNull();
    expect(out.get("authorization")).toBe("Bearer tok");
    expect(out.get("last-event-id")).toBe("9");
  });

  it("marks event streams as not transformable", () => {
    const out = forwardResponseHeaders(new Headers({ "content-type": "text/event-stream", "content-length": "5" }));
    expect(out.get("cache-control")).toBe("no-cache, no-transform");
    expect(out.get("content-length")).toBeNull();
  });
});

describe("proxy route against a fake API server", () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  const saved = { url: process.env.INVISIBLE_DOTS_URL, token: process.env.INVISIBLE_DOTS_TOKEN };

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
        if (req.url === "/api/stream?dot_id=d1") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('id: 1\ndata: {"id":1,"type":"dot.created","data":{}}\n\n');
          res.end();
          return;
        }
        if (req.url === "/api/dots/d1/browser-identities") {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "computer_stopped", message: "the computer is stopped" }));
          return;
        }
        if (req.method === "DELETE") {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.INVISIBLE_DOTS_URL = base;
    process.env.INVISIBLE_DOTS_TOKEN = "test-token";
  });

  afterAll(async () => {
    process.env.INVISIBLE_DOTS_URL = saved.url;
    process.env.INVISIBLE_DOTS_TOKEN = saved.token;
    if (saved.url === undefined) delete process.env.INVISIBLE_DOTS_URL;
    if (saved.token === undefined) delete process.env.INVISIBLE_DOTS_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
  const local = (path: string, init?: RequestInit) =>
    new Request(`http://127.0.0.1:3000/api/${path}`, {
      ...init,
      headers: { host: "127.0.0.1:3000", ...(init?.headers as Record<string, string> | undefined) },
    });

  it("forwards a POST with the token and the JSON body", async () => {
    const response = await POST(
      local("dots", { method: "POST", body: '{"config":"name: x"}', headers: { "content-type": "application/json" } }),
      context("dots"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ method: "POST", url: "/api/dots", auth: "Bearer test-token", body: '{"config":"name: x"}' }]);
  });

  it("passes API errors through unchanged", async () => {
    const response = await GET(local("dots/d1/browser-identities"), context("dots", "d1", "browser-identities"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "computer_stopped", message: "the computer is stopped" });
  });

  it("streams server-sent events", async () => {
    const response = await GET(local("stream?dot_id=d1"), context("stream"));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(await response.text()).toContain('"type":"dot.created"');
  });

  it("answers 204 without a body", async () => {
    const response = await DELETE(local("dots/d1", { method: "DELETE" }), context("dots", "d1"));
    expect(response.status).toBe(204);
    expect(seen[0]).toMatchObject({ method: "DELETE", url: "/api/dots/d1" });
  });

  it("refuses a foreign origin before contacting the API", async () => {
    const response = await POST(
      local("dots", { method: "POST", body: "{}", headers: { origin: "http://evil.example" } }),
      context("dots"),
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("serves the SDK unchanged: same-origin /api paths reach the API with the token", async () => {
    const handlers: Record<string, typeof GET> = { GET, POST, DELETE };
    const client = new InvisibleDotsClient({
      baseUrl: "",
      fetch: async (input, init) => {
        const url = new URL(String(input), "http://127.0.0.1:3000");
        const segments = url.pathname.replace(/^\/api\//, "").split("/").map(decodeURIComponent);
        const headers = new Headers(init?.headers);
        headers.set("host", "127.0.0.1:3000");
        const request = new Request(url, { ...init, headers });
        const handler = handlers[request.method];
        if (!handler) throw new Error(`no handler for ${request.method}`);
        return handler(request, context(...segments));
      },
    });
    await client.deleteDot("d1");
    await expect(client.listIdentities("d1")).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    expect(seen.map((s) => [s.method, s.url, s.auth])).toEqual([
      ["DELETE", "/api/dots/d1", "Bearer test-token"],
      ["GET", "/api/dots/d1/browser-identities", "Bearer test-token"],
    ]);
  });

  it("answers 502 with a clear message when the API is down", async () => {
    process.env.INVISIBLE_DOTS_URL = "http://127.0.0.1:1";
    try {
      const response = await GET(local("health"), context("health"));
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("api_unreachable");
      expect(body.message).toContain("http://127.0.0.1:1");
    } finally {
      process.env.INVISIBLE_DOTS_URL = base;
    }
  });
});
