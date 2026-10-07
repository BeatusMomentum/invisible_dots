import type { AddressInfo } from "node:net";
import { ChannelHub, TelegramChannelType } from "@invisible-dots/channels";
import { FakeBotApi } from "@invisible-dots/channels/testing";
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { Scheduler } from "@invisible-dots/scheduler";
import { FakeDriver, ManualClock, waitFor, waitUntilSettledReady } from "@invisible-dots/scheduler/testing";
import { InvisibleDotsClient } from "@invisible-dots/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer, type FastifyInstance } from "../src/index.js";
import { hostFacts } from "./host-facts.js";

const API_TOKEN = "test-token-0123456789abcdef";
const BOT_TOKEN = "123456:SECRET-TOKEN-VALUE";
const OTHER_BOT_TOKEN = "654321:OTHER-SECRET-TOKEN-VALUE";

const yaml = (name: string) => `name: ${name}\nmodel:\n  provider: openrouter\n  id: test/model\n`;

describe.each(testAdapters())("channel routes of the control-plane API (%s)", { timeout: 60_000 }, (kind) => {
  let t: TestDatabase;
  let db: Database;
  let bots: FakeBotApi;
  let app: FastifyInstance;
  let scheduler: Scheduler;
  let hub: ChannelHub;
  let driver: FakeDriver;
  let base: string;
  let api: InvisibleDotsClient;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
    bots = await FakeBotApi.start();
    driver = new FakeDriver();
    scheduler = new Scheduler({
      db,
      driver,
      clock: new ManualClock(),
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10 },
      dispatcher: { retryDelayMs: 0 },
    });
    hub = new ChannelHub({
      db,
      host: scheduler,
      types: [new TelegramChannelType({ apiRoot: bots.apiRoot, pollSeconds: 30 })],
      backoff: { initialMs: 1, maxMs: 5, jitter: 0 },
    });
    app = buildServer({ scheduler, channels: hub, doctor: async () => [], host: hostFacts(), token: API_TOKEN });
    await scheduler.start();
    await hub.start();
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    api = new InvisibleDotsClient({ baseUrl: base, token: API_TOKEN });
  }, 60_000);

  beforeEach(() => {
    bots.addBot(BOT_TOKEN, "dot_helper_bot");
    bots.addBot(OTHER_BOT_TOKEN, "second_bot");
  });

  afterEach(async () => {
    // A bot serves one Dot: what a test linked must not keep the next test from linking it.
    for (const dot of await api.listDots()) {
      for (const channel of await api.channels(dot.id)) await api.removeChannel(dot.id, channel.kind);
    }
  });

  afterAll(async () => {
    await app?.close();
    await hub?.close();
    await scheduler?.close();
    await bots?.close();
    await t?.drop();
  });

  async function readyDot() {
    const name = `chan-${++seq}`;
    const dot = await api.createDot(yaml(name));
    await waitUntilSettledReady(scheduler, driver, dot.id, name);
    return dot;
  }

  /** A raw request, to see the status and the body exactly as sent. */
  async function raw(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${API_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  it("lists nothing for a Dot without channels, and needs the API token like every route", async () => {
    const dot = await readyDot();
    expect(await api.channels(dot.id)).toEqual([]);
    for (const [method, path] of [
      ["GET", `/api/dots/${dot.id}/channels`],
      ["PUT", `/api/dots/${dot.id}/channels/telegram`],
      ["PATCH", `/api/dots/${dot.id}/channels/telegram`],
      ["DELETE", `/api/dots/${dot.id}/channels/telegram`],
      ["POST", `/api/dots/${dot.id}/channels/telegram/pairing`],
      ["DELETE", `/api/dots/${dot.id}/channels/telegram/peers/10`],
    ] as const) {
      const response = await fetch(`${base}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("links a bot (201), shows its name, never returns the token, and replaces the token of a linked bot (200)", async () => {
    const dot = await readyDot();
    const created = await raw("PUT", `/api/dots/${dot.name}/channels/telegram`, { token: ` ${BOT_TOKEN} ` });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ kind: "telegram", enabled: true, account: "dot_helper_bot", peers: [], settings: { approvals: true, notify_tasks: true } });
    expect(created.text).not.toContain("SECRET-TOKEN");
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBe(BOT_TOKEN);

    expect(JSON.stringify(await api.channels(dot.id))).not.toContain("SECRET-TOKEN");
    await waitFor(async () => (await api.channels(dot.name))[0]!.status === "connected", "connected");

    const replaced = await raw("PUT", `/api/dots/${dot.id}/channels/telegram`, { token: OTHER_BOT_TOKEN });
    expect(replaced.status).toBe(200);
    expect(replaced.json).toMatchObject({ kind: "telegram", account: "second_bot" });
    expect(replaced.text).not.toContain("SECRET-TOKEN");
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBe(OTHER_BOT_TOKEN);
    expect(await api.channels(dot.id)).toHaveLength(1);
  });

  it("pairs a person through the code, lists them, and revokes them", async () => {
    const dot = await readyDot();
    await api.putTelegramChannel(dot.id, BOT_TOKEN);
    await waitFor(() => bots.polling(BOT_TOKEN), "polling");
    const pairing = await api.pairChannel(dot.id, "telegram");
    expect(pairing.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(pairing.deep_link).toBe(`https://t.me/dot_helper_bot?start=${pairing.code}`);
    expect(new Date(pairing.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect((await raw("POST", `/api/dots/${dot.id}/channels/telegram/pairing`)).status).toBe(201);

    bots.say(BOT_TOKEN, `/start ${pairing.code}`, { id: 10, first_name: "Ann" });
    await waitFor(async () => (await api.channels(dot.id))[0]!.peers.length === 1, "the person to be paired");
    expect((await api.channels(dot.id))[0]!.peers[0]).toMatchObject({ peer_id: "10", role: "owner", label: "Ann" });

    expect((await raw("DELETE", `/api/dots/${dot.id}/channels/telegram/peers/10`)).status).toBe(204);
    expect((await api.channels(dot.id))[0]!.peers).toEqual([]);
    await expect(api.removeChannelPeer(dot.id, "telegram", "10")).rejects.toMatchObject({ status: 404 });
  });

  it("changes settings and pauses and resumes the channel, and refuses what is not a setting", async () => {
    const dot = await readyDot();
    await api.putTelegramChannel(dot.id, BOT_TOKEN);
    expect((await api.patchChannel(dot.id, "telegram", { settings: { notify_tasks: false } })).settings).toEqual({ approvals: true, notify_tasks: false, show_arguments: true });
    expect((await api.patchChannel(dot.id, "telegram", { settings: { show_arguments: false } })).settings).toEqual({ approvals: true, notify_tasks: false, show_arguments: false });
    const paused = await api.patchChannel(dot.id, "telegram", { enabled: false });
    expect(paused).toMatchObject({ enabled: false, settings: { approvals: true, notify_tasks: false } });
    await waitFor(() => !bots.polling(BOT_TOKEN), "polling to stop");
    const both = await api.patchChannel(dot.id, "telegram", { enabled: true, settings: { approvals: false } });
    expect(both).toMatchObject({ enabled: true, settings: { approvals: false, notify_tasks: false } });
    await waitFor(() => bots.polling(BOT_TOKEN), "polling again");

    for (const body of [{}, { enabled: "yes" }, { settings: { colour: true } }, { settings: { approvals: "no" } }, { settings: [] }]) {
      const refused = await raw("PATCH", `/api/dots/${dot.id}/channels/telegram`, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.json).toMatchObject({ error: "invalid_request" });
    }
    expect((await api.channels(dot.id))[0]!.settings).toEqual({ approvals: false, notify_tasks: false, show_arguments: false });
  });

  it("unlinks: the channel stops, its token and people are deleted, and it is gone for a second try", async () => {
    const dot = await readyDot();
    await api.putTelegramChannel(dot.id, BOT_TOKEN);
    await waitFor(() => bots.polling(BOT_TOKEN), "polling");
    expect((await raw("DELETE", `/api/dots/${dot.id}/channels/telegram`)).status).toBe(204);
    await waitFor(() => !bots.polling(BOT_TOKEN), "polling to stop");
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBeNull();
    expect(await api.channels(dot.id)).toEqual([]);
    await expect(api.removeChannel(dot.id, "telegram")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(api.patchChannel(dot.id, "telegram", { enabled: true })).rejects.toMatchObject({ status: 404 });
    await expect(api.pairChannel(dot.id, "telegram")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses with a status and a message that never carry the token: no token, a wrong one, a malformed one, an unreachable Telegram, a bot in use", async () => {
    const dot = await readyDot();
    const other = await readyDot();
    const url = `/api/dots/${dot.id}/channels/telegram`;
    const answers = [
      await raw("PUT", url, {}),
      await raw("PUT", url, { token: 42 }),
      await raw("PUT", url, { token: "   " }),
      await raw("PUT", url, { token: "999:UNKNOWN-TOKEN-VALUE" }),
      await raw("PUT", url, { token: "bad token with spaces" }),
    ];
    expect(answers.map((a) => a.status)).toEqual([400, 400, 400, 400, 400]);
    expect(answers.map((a) => a.json?.error)).toEqual(["invalid_request", "invalid_request", "invalid_request", "invalid_credentials", "invalid_credentials"]);
    expect(answers[3]!.json?.message).toMatch(/refused the bot token/);

    bots.addBot("777:UNREACHABLE-TOKEN-VALUE", "third_bot");
    bots.failNext("777:UNREACHABLE-TOKEN-VALUE", "getMe", "drop");
    const unreachable = await raw("PUT", url, { token: "777:UNREACHABLE-TOKEN-VALUE" });
    expect(unreachable.status).toBe(502);
    expect(unreachable.json?.error).toBe("channel_unreachable");
    expect(unreachable.text).not.toContain("UNREACHABLE-TOKEN-VALUE");
    expect(await api.channels(dot.id)).toEqual([]);
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBeNull();

    await api.putTelegramChannel(dot.id, BOT_TOKEN);
    const inUse = await raw("PUT", `/api/dots/${other.id}/channels/telegram`, { token: BOT_TOKEN });
    expect(inUse.status).toBe(409);
    expect(inUse.json?.error).toBe("account_in_use");
    expect(inUse.text).not.toContain("SECRET-TOKEN");
    expect(await api.channels(other.id)).toEqual([]);

    for (const answer of [...answers, unreachable, inUse]) expect(answer.text).not.toContain(BOT_TOKEN.split(":")[1]);
  });

  it("answers 404 for a Dot that does not exist and 400 for a channel kind that does not", async () => {
    const dot = await readyDot();
    await expect(api.channels("no-such-dot")).rejects.toMatchObject({ status: 404 });
    await expect(api.putTelegramChannel("no-such-dot", BOT_TOKEN)).rejects.toMatchObject({ status: 404 });
    for (const [method, path] of [
      ["PATCH", `/api/dots/${dot.id}/channels/carrier-pigeon`],
      ["DELETE", `/api/dots/${dot.id}/channels/carrier-pigeon`],
      ["POST", `/api/dots/${dot.id}/channels/carrier-pigeon/pairing`],
      ["DELETE", `/api/dots/${dot.id}/channels/carrier-pigeon/peers/1`],
    ] as const) {
      const answer = await raw(method, path, method === "PATCH" ? { enabled: true } : undefined);
      expect(answer.status, `${method} ${path}`).toBe(400);
      expect(answer.json?.message).toMatch(/the channels are telegram, whatsapp/);
    }
    // A channel this server has no adapter for yet answers like one that is not linked.
    await expect(api.pairChannel(dot.id, "whatsapp")).rejects.toMatchObject({ status: 404 });
  });
});
