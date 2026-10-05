import type { StoredEvent } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { ApiError, InvisibleDotsClient, STREAM_ERROR_EVENT } from "../src/index.js";

function event(id: number): StoredEvent {
  return {
    id,
    dot_id: "dot_a",
    type: "computer.started",
    data: {},
    source: "host",
    guest_seq: null,
    created_at: new Date().toISOString(),
  };
}

function sse(...messages: string[]): Response {
  return new Response(messages.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("InvisibleDotsClient", () => {
  it("sends the bearer token and turns error bodies into ApiError", async () => {
    const seen: Request[] = [];
    const client = new InvisibleDotsClient({
      baseUrl: "http://api.test/",
      token: "secret-token",
      fetch: async (input, init) => {
        seen.push(new Request(input, init));
        return new Response(JSON.stringify({ error: "not_found", message: 'Dot "x" not found' }), { status: 404 });
      },
    });
    const error = await client.getDot("x y").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found", message: 'Dot "x" not found' });
    expect(seen[0]?.url).toBe("http://api.test/api/dots/x%20y");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("channel methods send the method, path and body the API routes expect, with names and ids encoded", async () => {
    const seen: { method: string; url: string; body: string }[] = [];
    const record = { kind: "telegram", enabled: true, status: "connected", status_detail: null, bot_username: "b", settings: { approvals: true, notify_tasks: true }, peers: [], created_at: "now" };
    const client = new InvisibleDotsClient({
      baseUrl: "http://api.test",
      token: "t",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push({ method: request.method, url: request.url, body: await request.text() });
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (request.method === "GET") return new Response(JSON.stringify({ channels: [record] }));
        if (request.url.endsWith("/pairing")) return new Response(JSON.stringify({ code: "ABCD2345", deep_link: null, expires_at: "later" }), { status: 201 });
        return new Response(JSON.stringify(record));
      },
    });
    expect(await client.channels("my dot")).toEqual([record]);
    expect(await client.putTelegramChannel("my dot", "1:TOKEN")).toEqual(record);
    expect(await client.patchChannel("my dot", "telegram", { enabled: false, settings: { notify_tasks: false } })).toEqual(record);
    expect(await client.pairChannel("my dot", "telegram")).toEqual({ code: "ABCD2345", deep_link: null, expires_at: "later" });
    await client.removeChannelPeer("my dot", "telegram", "a/b");
    await client.removeChannel("my dot", "telegram");
    expect(seen.map((r) => [r.method, r.url.replace("http://api.test", ""), r.body])).toEqual([
      ["GET", "/api/dots/my%20dot/channels", ""],
      ["PUT", "/api/dots/my%20dot/channels/telegram", '{"token":"1:TOKEN"}'],
      ["PATCH", "/api/dots/my%20dot/channels/telegram", '{"enabled":false,"settings":{"notify_tasks":false}}'],
      ["POST", "/api/dots/my%20dot/channels/telegram/pairing", ""],
      ["DELETE", "/api/dots/my%20dot/channels/telegram/peers/a%2Fb", ""],
      ["DELETE", "/api/dots/my%20dot/channels/telegram", ""],
    ]);
  });

  it("reports an unreachable server as status 0 / unreachable", async () => {
    const client = new InvisibleDotsClient({
      baseUrl: "http://api.test",
      token: "t",
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8787") });
      },
    });
    await expect(client.health()).rejects.toMatchObject({ status: 0, code: "unreachable", message: /ECONNREFUSED/ });
  });

  it("stream resumes after the last event when the connection drops, and stops on 4xx", async () => {
    const urls: string[] = [];
    let call = 0;
    const client = new InvisibleDotsClient({
      baseUrl: "http://api.test",
      token: "t",
      fetch: async (input) => {
        urls.push(String(input));
        call++;
        if (call === 1) return sse(`id: 1\ndata: ${JSON.stringify(event(1))}\n\n`, `id: 2\ndata: ${JSON.stringify(event(2))}\n\n`);
        if (call === 2) return sse(`event: ${STREAM_ERROR_EVENT}\ndata: {"error":"stream_overflow","message":"behind"}\n\n`);
        if (call === 3) return sse(`id: 3\ndata: ${JSON.stringify(event(3))}\n\n`);
        return new Response(JSON.stringify({ error: "unauthorized", message: "no" }), { status: 401 });
      },
    });
    const reasons: string[] = [];
    const got: number[] = [];
    const error = await (async () => {
      for await (const e of client.stream({ dotId: "dot_a", onReconnect: ({ error }) => reasons.push(error.message) })) {
        got.push(e.id);
      }
    })().catch((e: unknown) => e);
    expect(got).toEqual([1, 2, 3]);
    expect(urls).toEqual([
      "http://api.test/api/stream?dot_id=dot_a",
      "http://api.test/api/stream?dot_id=dot_a&after=2",
      "http://api.test/api/stream?dot_id=dot_a&after=2",
      "http://api.test/api/stream?dot_id=dot_a&after=3",
    ]);
    expect(reasons[1]).toMatch(/behind/);
    expect(error).toMatchObject({ status: 401 });
  });

  it("without a token sends same-origin requests with no Authorization header, as the web client does", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const client = new InvisibleDotsClient({
      baseUrl: "",
      fetch: async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return Response.json({ dots: [] });
      },
    });
    expect(await client.listDots()).toEqual([]);
    expect(seen[0]?.url).toBe("/api/dots");
    expect(seen[0]?.headers.has("authorization")).toBe(false);
  });

  it("stream retries after a 5xx answer and reports every connection it opens", async () => {
    let call = 0;
    const controller = new AbortController();
    const client = new InvisibleDotsClient({
      baseUrl: "http://api.test",
      token: "t",
      fetch: async () => {
        call++;
        if (call === 1) return new Response(JSON.stringify({ error: "internal", message: "db down" }), { status: 503 });
        return sse(`id: 9\ndata: ${JSON.stringify(event(9))}\n\n`);
      },
    });
    let opened = 0;
    const reasons: string[] = [];
    const got: number[] = [];
    for await (const e of client.stream({
      signal: controller.signal,
      onOpen: () => opened++,
      onReconnect: ({ error }) => reasons.push(error.message),
    })) {
      got.push(e.id);
      controller.abort();
    }
    expect(got).toEqual([9]);
    expect(opened).toBe(1);
    expect(reasons[0]).toMatch(/db down/);
  });
});
