/**
 * The WhatsApp routes of the control-plane API: starting a link, the stream of codes to scan, and what a server
 * that does not run WhatsApp (the default: it is opt-in) says. The channel is the real one on a fake connection.
 */
import type { AddressInfo } from "node:net";
import { ChannelHub, WhatsAppChannelType } from "@invisible-dots/channels";
import { FakeChannelType, FakeWhatsAppConnector } from "@invisible-dots/channels/testing";
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { Scheduler } from "@invisible-dots/scheduler";
import { FakeDriver, ManualClock, waitFor, waitUntilSettledReady } from "@invisible-dots/scheduler/testing";
import { InvisibleDotsClient } from "@invisible-dots/sdk";
import type { ChannelLinkFrame } from "@invisible-dots/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer, defaultChannelTypes, type FastifyInstance } from "../src/index.js";

const API_TOKEN = "test-token-0123456789abcdef";
const NUMBER = "15550001111";
const yaml = (name: string) => `name: ${name}\ngoal: watch fares\nmodel:\n  provider: openrouter\n  id: test/model\n`;

describe.each(testAdapters())("WhatsApp routes of the control-plane API (%s)", { timeout: 60_000 }, (kind) => {
  let t: TestDatabase;
  let db: Database;
  let app: FastifyInstance;
  let plain: FastifyInstance;
  let scheduler: Scheduler;
  let hub: ChannelHub;
  let plainHub: ChannelHub;
  let driver: FakeDriver;
  let connector: FakeWhatsAppConnector;
  let base: string;
  let plainBase: string;
  let api: InvisibleDotsClient;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
    driver = new FakeDriver();
    scheduler = new Scheduler({
      db,
      driver,
      clock: new ManualClock(),
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10 },
      dispatcher: { retryDelayMs: 0 },
    });
    connector = new FakeWhatsAppConnector();
    hub = new ChannelHub({
      db,
      host: scheduler,
      types: [new FakeChannelType(), new WhatsAppChannelType({ connector: () => connector, pauseMs: () => 0 })],
      backoff: { initialMs: 1, maxMs: 5, jitter: 0 },
    });
    app = buildServer({ scheduler, channels: hub, doctor: async () => [], token: API_TOKEN, heartbeatMs: 50 });
    // The server as it is when WhatsApp was not asked for: Telegram only. It never starts a binding.
    plainHub = new ChannelHub({ db, host: scheduler, types: [new FakeChannelType()] });
    plain = buildServer({ scheduler, channels: plainHub, doctor: async () => [], token: API_TOKEN });
    await scheduler.start();
    await hub.start();
    await app.listen({ host: "127.0.0.1", port: 0 });
    await plain.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    plainBase = `http://127.0.0.1:${(plain.server.address() as AddressInfo).port}`;
    api = new InvisibleDotsClient({ baseUrl: base, token: API_TOKEN });
  }, 60_000);

  afterEach(async () => {
    for (const dot of await api.listDots()) {
      for (const channel of await api.channels(dot.id)) await api.removeChannel(dot.id, channel.kind);
    }
    connector.connections.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await plain?.close();
    await hub?.close();
    await scheduler?.close();
    await t?.drop();
  });

  async function readyDot() {
    const name = `wa-${++seq}`;
    const dot = await api.createDot(yaml(name));
    await waitUntilSettledReady(scheduler, driver, dot.id, name);
    return dot;
  }

  async function raw(origin: string, method: string, path: string) {
    const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${API_TOKEN}` } });
    const text = await response.text();
    return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  async function linkedDot() {
    const dot = await readyDot();
    await api.linkWhatsApp(dot.id);
    await waitFor(() => connector.connections.length === 1, "the connection");
    connector.current.open(NUMBER);
    await waitFor(async () => (await api.channels(dot.id))[0]?.status === "connected", "connected");
    return dot;
  }

  it("needs the API token like every route", async () => {
    const dot = await readyDot();
    for (const [method, path] of [
      ["POST", `/api/dots/${dot.id}/channels/whatsapp/link`],
      ["GET", `/api/dots/${dot.id}/channels/whatsapp/qr`],
    ] as const) {
      expect((await fetch(`${base}${path}`, { method })).status, `${method} ${path}`).toBe(401);
    }
  });

  it("lists the kinds this server runs next to the Dot's channels", async () => {
    const dot = await readyDot();
    expect(await api.channelsOverview(dot.id)).toEqual({ channels: [], available: ["telegram", "whatsapp"] });
    const plainAnswer = await raw(plainBase, "GET", `/api/dots/${dot.id}/channels`);
    expect(plainAnswer.json).toEqual({ channels: [], available: ["telegram"] });
  });

  it("is off unless the server was started with it, and says how to turn it on", async () => {
    const dot = await readyDot();
    const link = await raw(plainBase, "POST", `/api/dots/${dot.id}/channels/whatsapp/link`);
    expect(link.status).toBe(400);
    expect(link.json).toMatchObject({ error: "invalid_request", message: expect.stringContaining("INVISIBLE_DOTS_WHATSAPP=1") });
    expect((await raw(plainBase, "GET", `/api/dots/${dot.id}/channels/whatsapp/qr`)).status).toBe(400);
  });

  it("starts a link with 202 and the record of a channel that waits, and streams the codes and the end", async () => {
    const dot = await readyDot();
    const started = await raw(base, "POST", `/api/dots/${dot.id}/channels/whatsapp/link`);
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ kind: "whatsapp", enabled: true, status: "connecting", account: null, peers: [] });

    const frames: ChannelLinkFrame[] = [];
    const controller = new AbortController();
    const reading = (async () => {
      for await (const frame of api.whatsappLink(dot.id, { signal: controller.signal })) frames.push(frame);
    })();
    await waitFor(() => connector.connections.length === 1, "the connection");
    await waitFor(() => frames.length === 1, "the first frame");
    connector.current.showCode("2@first");
    await waitFor(() => frames.length === 2, "the first code");
    connector.current.showCode("2@second");
    connector.current.open(NUMBER);
    await reading;
    expect(frames).toEqual([{ state: "waiting" }, { state: "code", code: "2@first" }, { state: "code", code: "2@second" }, { state: "linked", account: NUMBER }]);
    expect(await api.channels(dot.id)).toMatchObject([{ kind: "whatsapp", status: "connected", account: NUMBER }]);
  });

  it("answers the stream as an uncached event stream with a heartbeat, and never writes a code anywhere else", async () => {
    const dot = await readyDot();
    await api.linkWhatsApp(dot.id);
    await waitFor(() => connector.connections.length === 1, "the connection");
    connector.current.showCode("2@SECRET-CODE-TO-SCAN");
    const controller = new AbortController();
    const response = await fetch(`${base}/api/dots/${dot.id}/channels/whatsapp/qr`, { headers: { authorization: `Bearer ${API_TOKEN}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes(": ping")) text += (await reader.read()).value ?? "";
    expect(text).toContain(": connected");
    expect(text).toContain(`data: ${JSON.stringify({ state: "code", code: "2@SECRET-CODE-TO-SCAN" })}`);
    controller.abort();
    await reader.cancel().catch(() => {});
    expect(JSON.stringify(await api.channels(dot.id))).not.toContain("SECRET-CODE-TO-SCAN");
    expect(JSON.stringify(await api.events(dot.id))).not.toContain("SECRET-CODE-TO-SCAN");
  });

  it("is a 404 before anything is linked, as JSON and not as a stream", async () => {
    const dot = await readyDot();
    const qr = await raw(base, "GET", `/api/dots/${dot.id}/channels/whatsapp/qr`);
    expect(qr.status).toBe(404);
    expect(qr.json).toMatchObject({ error: "not_found" });
    expect((await raw(base, "GET", `/api/dots/nothing-here/channels/whatsapp/qr`)).status).toBe(404);
    expect((await raw(base, "POST", `/api/dots/nothing-here/channels/whatsapp/link`)).status).toBe(404);
  });

  it("refuses to link a channel that is linked", async () => {
    const dot = await linkedDot();
    const again = await raw(base, "POST", `/api/dots/${dot.id}/channels/whatsapp/link`);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: "already_linked" });
    const frames: ChannelLinkFrame[] = [];
    for await (const frame of api.whatsappLink(dot.id)) frames.push(frame);
    expect(frames).toEqual([{ state: "linked", account: NUMBER }]);
  });

  it("pairs with a link and the words to send, and removes the channel with everything it kept", async () => {
    const dot = await linkedDot();
    await db.secrets.put(dot.id, "whatsapp_creds", "identity");
    const pairing = await api.pairChannel(dot.id, "whatsapp");
    expect(pairing.deep_link).toBe(`https://wa.me/${NUMBER}?text=pair%20${pairing.code}`);
    expect(pairing.message).toBe(`pair ${pairing.code}`);
    await api.removeChannel(dot.id, "whatsapp");
    expect(await api.channels(dot.id)).toEqual([]);
    expect(await db.secrets.get(dot.id, "whatsapp_creds")).toBeNull();
  });

  it("runs WhatsApp only when INVISIBLE_DOTS_WHATSAPP=1, and Telegram always", () => {
    expect(defaultChannelTypes({}).map((type) => type.kind)).toEqual(["telegram"]);
    expect(defaultChannelTypes({ INVISIBLE_DOTS_WHATSAPP: "0" }).map((type) => type.kind)).toEqual(["telegram"]);
    expect(defaultChannelTypes({ INVISIBLE_DOTS_WHATSAPP: "1" }).map((type) => type.kind)).toEqual(["telegram", "whatsapp"]);
  });
});
