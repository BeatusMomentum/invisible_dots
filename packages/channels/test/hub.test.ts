import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { Scheduler } from "@invisible-dots/scheduler";
import { FakeDriver, ManualClock, waitFor, waitUntilSettledReady } from "@invisible-dots/scheduler/testing";
import type { ChannelKind, StoredEvent } from "@invisible-dots/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChannelHub, ChannelNeedsRelinkError, ChannelSendError, type ChannelHubOptions } from "../src/index.js";
import { FakeChannelType } from "../src/testing.js";

const yaml = (name: string) => `name: ${name}\ngoal: keep watch\nmodel:\n  provider: openrouter\n  id: test/model\n`;
const FAST = { initialMs: 1, maxMs: 5, jitter: 0 };
const TOKEN = "123456:SECRET-TOKEN-VALUE";

/** Let the hub and the event loops settle: nothing they would do in the meantime is left undone. */
const quiet = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(testAdapters())("channel hub, with the real Scheduler and a fake guest (%s)", { timeout: 60_000 }, (kind) => {
  let t: TestDatabase;
  let db: Database;
  const closers: (() => Promise<unknown>)[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
  }, 60_000);

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    // The next test's hub starts every binding in the database: it must find only its own.
    await db.query("DELETE FROM channel_bindings");
  });

  afterAll(async () => {
    await t?.drop();
  });

  async function world() {
    const driver = new FakeDriver();
    const scheduler = new Scheduler({
      db,
      driver,
      clock: new ManualClock(),
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10, pumpMaxRetryMs: 50 },
      dispatcher: { retryDelayMs: 0, maxDeliveryAttempts: 2 },
    });
    closers.push(() => scheduler.close());
    const clock = new ManualClock();
    const hubs: ChannelHub[] = [];
    /** A hub on this scheduler, started; `type` is what the hub makes channels with. */
    async function hub(type = new FakeChannelType(), options: Partial<ChannelHubOptions> = {}) {
      const h = new ChannelHub({ db, host: scheduler, types: [type], clock, backoff: FAST, ...options });
      hubs.push(h);
      closers.push(() => h.close());
      await h.start();
      return { hub: h, type };
    }
    async function dot(name = `dot-${++seq}-${Math.random().toString(36).slice(2, 6)}`) {
      const created = await scheduler.createDot(yaml(name));
      await waitUntilSettledReady(scheduler, driver, created.id, name);
      return { ...created, guest: driver.guestOf(created.id) };
    }
    return { driver, scheduler, clock, hub, dot };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** A Dot with a Telegram-like channel linked and the given people paired (peer id = chat id). */
  async function linked(w: World, people: string[] = ["10"], options: Partial<ChannelHubOptions> = {}, type?: FakeChannelType) {
    const { hub, type: made } = await w.hub(type, options);
    const dot = await w.dot();
    await hub.add(dot.id, "telegram");
    const channel = await waitFor(() => made.channels.at(-1)?.sink && made.channels.at(-1), "the channel to run");
    for (const person of people) {
      const { code } = await hub.pair(dot.id, "telegram");
      expect(await channel.pair(code, person, person, `Person ${person}`)).toBe(true);
    }
    channel.sent.length = 0;
    return { hub, type: made, dot, channel };
  }

  const userMessages = (dotId: string) => db.events.list({ dotId, types: ["user.message"] });
  const eventsOf = async (dotId: string, type: string): Promise<StoredEvent[]> => db.events.list({ dotId, types: [type] });

  // A person talks to the Dot and it answers

  it("carries a paired person's message to the Dot as plain text and the answer back to that chat only", async () => {
    const w = await world();
    const { hub, dot, channel } = await linked(w, ["10", "20"]);
    await channel.receive({ text: "hello", peerId: "10", chatId: "10" });

    expect(dot.guest.inbound.at(-1)).toMatchObject({ type: "user.message", data: { text: "hello" } });
    expect(Object.keys(dot.guest.inbound.at(-1)!.data)).toEqual(["text"]);
    const [logged] = await userMessages(dot.id);
    const bindingId = (logged!.data.origin as { binding_id: string }).binding_id;
    expect(logged!.data.origin).toEqual({ channel: "telegram", binding_id: bindingId, chat_id: "10", external_id: "update-1" });
    const conversation = await w.scheduler.conversation(dot.id);
    expect(conversation.find((m) => m.role === "user")?.origin?.chat_id).toBe("10");

    await waitFor(() => channel.texts("10").length > 0, "the answer");
    expect(channel.texts("10")).toEqual(["echo: hello"]);
    expect(channel.texts("20")).toEqual([]);
    expect((await hub.list(dot.id))[0]!.peers.map((p) => p.peer_id)).toEqual(["10", "20"]);
  });

  it("does not mirror an answer to a message sent from the web", async () => {
    const w = await world();
    const { dot, channel } = await linked(w);
    await w.scheduler.sendMessage(dot.id, "from the web");
    await waitFor(async () => (await w.scheduler.conversation(dot.id)).some((m) => m.role === "assistant"), "the answer in the log");
    await channel.receive({ text: "from the chat", peerId: "10", chatId: "10" });
    await waitFor(() => channel.texts().length > 0, "the chat answer");
    await quiet();
    expect(channel.texts()).toEqual(["echo: from the chat"]);
  });

  it("sends an answer that answers nothing, such as an automation's, to every owner", async () => {
    const w = await world();
    const { dot, channel } = await linked(w, ["10", "20"]);
    dot.guest.emit("message.assistant", { text: "daily report" });
    await waitFor(() => channel.sent.length >= 2, "both owners");
    expect(channel.sent.map((m) => [m.chatId, m.text])).toEqual([
      ["10", "daily report"],
      ["20", "daily report"],
    ]);
  });

  it("sends task results to the owners unless notify_tasks is off", async () => {
    const w = await world();
    const { hub, dot, channel } = await linked(w);
    dot.guest.emit("task.completed", { task_id: "task_1", summary: "all done" });
    dot.guest.emit("task.failed", { task_id: "task_2", error: "it broke" });
    await waitFor(() => channel.sent.length >= 2, "both results");
    expect(channel.texts()).toEqual(["Task completed: all done", "Task failed: it broke"]);

    expect((await hub.setSettings(dot.id, "telegram", { notify_tasks: false })).settings).toEqual({ approvals: true, notify_tasks: false });
    dot.guest.emit("task.completed", { task_id: "task_3", summary: "silent" });
    dot.guest.emit("message.assistant", { text: "marker" });
    await waitFor(() => channel.texts().includes("marker"), "the marker");
    expect(channel.texts()).toEqual(["Task completed: all done", "Task failed: it broke", "marker"]);
  });

  it("shows typing in the chat that asked while the Dot thinks, not after the answer", async () => {
    const w = await world();
    const { dot, channel } = await linked(w);
    dot.guest.onInbound = () => {};
    await channel.receive({ text: "think about it", peerId: "10", chatId: "10" });
    const asked = dot.guest.inbound.at(-1)!;
    dot.guest.emit("agent.state", { state: "THINKING" });
    await waitFor(() => channel.typings.length === 1, "typing");
    expect(channel.typings).toEqual(["10"]);
    dot.guest.emit("message.assistant", { text: "thought", in_reply_to: asked.id });
    dot.guest.emit("agent.state", { state: "THINKING" });
    dot.guest.emit("message.assistant", { text: "marker" });
    await waitFor(() => channel.texts().includes("marker"), "the marker");
    expect(channel.typings).toEqual(["10"]);
  });

  it("splits a long answer into messages the channel accepts, in order", async () => {
    const w = await world();
    const type = new FakeChannelType();
    type.capabilities = { maxText: 30, typing: false };
    const { dot, channel } = await linked(w, ["10"], {}, type);
    const text = Array.from({ length: 20 }, (_, i) => `sentence ${i}.`).join(" ");
    dot.guest.emit("message.assistant", { text });
    await waitFor(() => channel.texts().join(" ").length >= text.length, "every piece");
    expect(channel.texts().every((p) => p.length <= 30)).toBe(true);
    expect(channel.texts().join(" ")).toBe(text);
  });

  it("does not replay what happened before the channel was linked", async () => {
    const w = await world();
    const { hub, type } = await w.hub();
    const dot = await w.dot();
    dot.guest.emit("message.assistant", { text: "old news" });
    await waitFor(async () => (await eventsOf(dot.id, "message.assistant")).length === 1, "the old event");
    await hub.add(dot.id, "telegram");
    const channel = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the channel");
    const { code } = await hub.pair(dot.id, "telegram");
    await channel.pair(code, "10");
    dot.guest.emit("message.assistant", { text: "fresh" });
    await waitFor(() => channel.texts().includes("fresh"), "the fresh answer");
    expect(channel.texts()).not.toContain("old news");
  });

  // Who may talk

  it("drops everything from a stranger before any write, and from a chat that is not private", async () => {
    const w = await world();
    const { dot, channel } = await linked(w, ["10"]);
    const before = {
      events: (await db.events.list({ dotId: dot.id })).length,
      inbound: (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM channel_inbound")).rows[0]!.n,
      delivered: dot.guest.inbound.length,
    };
    for (let i = 0; i < 100; i++) await channel.receive({ text: `spam ${i}`, peerId: "666", chatId: "666" });
    await channel.receive({ text: "in a group", peerId: "10", chatId: "-100", direct: false });
    expect(await channel.pair("WRONG123", "666", "666")).toBe(false);
    await quiet();
    expect((await db.events.list({ dotId: dot.id })).length).toBe(before.events);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM channel_inbound")).rows[0]!.n).toBe(before.inbound);
    expect(dot.guest.inbound.length).toBe(before.delivered);
    expect(channel.sent).toEqual([]);
  });

  it("pairs with a one-time code once, whatever its case, and keeps only its hash", async () => {
    const w = await world();
    const { hub, type } = await w.hub();
    const dot = await w.dot();
    await hub.add(dot.id, "telegram");
    const channel = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the channel");
    const { code, deep_link, expires_at } = await hub.pair(dot.id, "telegram");
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(deep_link).toBe(`https://chat.test/fake_bot?start=${code}`);
    expect(expires_at).toBe(new Date(w.clock.now().getTime() + 600_000).toISOString());
    const stored = await db.query<{ code_hash: string }>("SELECT code_hash FROM channel_pairings");
    expect(JSON.stringify(stored.rows)).not.toContain(code);

    expect(await channel.pair(` ${code.toLowerCase()} `, "10", "10", "Ada")).toBe(true);
    expect(await channel.pair(code, "11", "11")).toBe(false);
    expect(channel.texts("10")[0]).toMatch(/^Paired\./);
    expect((await hub.list(dot.id))[0]!.peers).toMatchObject([{ peer_id: "10", role: "owner", label: "Ada" }]);
    const [event] = await eventsOf(dot.id, "channel.peer.paired");
    expect(event!.data).toEqual({ kind: "telegram", peer_id: "10", label: "Ada" });
  });

  it("refuses a code after ten minutes, and pairing again updates the person instead of adding one", async () => {
    const w = await world();
    const { hub, dot, channel } = await linked(w, []);
    const { code } = await hub.pair(dot.id, "telegram");
    w.clock.advance(600_001);
    expect(await channel.pair(code, "10")).toBe(false);

    const fresh = await hub.pair(dot.id, "telegram");
    expect(await channel.pair(fresh.code, "10", "10", "First")).toBe(true);
    const again = await hub.pair(dot.id, "telegram");
    expect(await channel.pair(again.code, "10", "77", "Second")).toBe(true);
    expect((await hub.list(dot.id))[0]!.peers).toMatchObject([{ peer_id: "10", label: "Second" }]);
    dot.guest.emit("message.assistant", { text: "where" });
    await waitFor(() => channel.texts("77").includes("where"), "the new chat");
  });

  it("stops talking to a person who is revoked, and drops what they write", async () => {
    const w = await world();
    const { hub, dot, channel } = await linked(w, ["10", "20"]);
    await hub.removePeer(dot.id, "telegram", "10");
    await expect(hub.removePeer(dot.id, "telegram", "10")).rejects.toMatchObject({ status: 404 });
    const before = (await userMessages(dot.id)).length;
    await channel.receive({ text: "still here?", peerId: "10", chatId: "10" });
    expect((await userMessages(dot.id)).length).toBe(before);
    dot.guest.emit("message.assistant", { text: "report" });
    await waitFor(() => channel.texts("20").includes("report"), "the remaining owner");
    expect(channel.texts("10")).toEqual([]);
  });

  it("slows a person who writes too fast, tells them once, and takes messages again later", async () => {
    const w = await world();
    const { dot, channel } = await linked(w, ["10"], { limits: { burst: 3, perMinute: 60 } });
    for (let i = 0; i < 6; i++) await channel.receive({ text: `m${i}`, peerId: "10", chatId: "10" });
    expect((await userMessages(dot.id)).length).toBe(3);
    await waitFor(() => channel.texts().some((t) => t.startsWith("You are sending messages too fast")), "the notice");
    expect(channel.texts().filter((t) => t.startsWith("You are sending messages too fast"))).toHaveLength(1);
    w.clock.advance(5_000);
    await channel.receive({ text: "later", peerId: "10", chatId: "10" });
    expect((await userMessages(dot.id)).length).toBe(4);
  });

  it("refuses a message over the length limit with a notice", async () => {
    const w = await world();
    const { dot, channel } = await linked(w, ["10"], { limits: { maxChars: 20 } });
    await channel.receive({ text: "x".repeat(21), peerId: "10", chatId: "10" });
    expect((await userMessages(dot.id)).length).toBe(0);
    expect(channel.texts()).toEqual(["That message is too long: the limit is 20 characters."]);
    await channel.receive({ text: "x".repeat(20), peerId: "10", chatId: "10" });
    expect((await userMessages(dot.id)).length).toBe(1);
  });

  // Idempotency and restarts

  it("recognises a redelivered message by its channel id, also after a restart", async () => {
    const w = await world();
    const { dot, channel } = await linked(w);
    await channel.receive({ externalId: "u-1", text: "once", peerId: "10", chatId: "10" });
    await channel.receive({ externalId: "u-1", text: "once", peerId: "10", chatId: "10" });
    expect((await userMessages(dot.id)).length).toBe(1);
    expect(dot.guest.inbound.filter((e) => e.type === "user.message")).toHaveLength(1);

    const second = await w.hub();
    const restarted = await waitFor(() => second.type.channels.at(-1)?.sink && second.type.channels.at(-1), "the restarted channel");
    await restarted.receive({ externalId: "u-1", text: "once", peerId: "10", chatId: "10" });
    expect((await userMessages(dot.id)).length).toBe(1);
  });

  it("resumes from its cursor after a restart: no reply lost, none sent twice", async () => {
    const w = await world();
    const first = await linked(w, ["10"]);
    first.dot.guest.onInbound = () => {};
    await first.channel.receive({ text: "q1", peerId: "10", chatId: "10" });
    const asked = first.dot.guest.inbound.at(-1)!;
    first.dot.guest.emit("message.assistant", { text: "a0", in_reply_to: asked.id });
    await waitFor(() => first.channel.texts().includes("a0"), "the first reply");
    await first.hub.close();

    // The Dot answers while no hub runs.
    first.dot.guest.emit("message.assistant", { text: "a1", in_reply_to: asked.id });
    await waitFor(async () => (await eventsOf(first.dot.id, "message.assistant")).length === 2, "the second reply in the log");

    const second = await w.hub();
    const channel2 = await waitFor(() => second.type.channels.at(-1)?.sink && second.type.channels.at(-1), "the restarted channel");
    await waitFor(() => channel2.texts("10").length > 0, "the missed reply");
    expect(channel2.texts("10")).toEqual(["a1"]);

    await second.hub.close();
    const third = await w.hub();
    const channel3 = await waitFor(() => third.type.channels.at(-1)?.sink && third.type.channels.at(-1), "the third channel");
    await quiet();
    expect(channel3.sent).toEqual([]);
  });

  it("refuses a message that arrives after the hub stopped", async () => {
    const w = await world();
    const { hub, channel } = await linked(w);
    const sink = channel.sink!;
    await hub.close();
    await expect(sink.inbound({ externalId: "late", peerId: "10", chatId: "10", text: "hi", direct: true })).rejects.toThrow(/stopped/);
  });

  // Failures

  it("restarts a channel that fails, with its status in the log, and stops for one that needs a new login", async () => {
    const w = await world();
    const { hub, type } = await w.hub();
    const dot = await w.dot();
    await hub.add(dot.id, "telegram");
    const first = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the channel");
    first.crash(new Error("boom"));
    await waitFor(() => type.channels.length === 2, "a new channel");
    await waitFor(async () => (await eventsOf(dot.id, "channel.status")).length >= 3, "error and connected again");
    const statuses = (await eventsOf(dot.id, "channel.status")).map((e) => [e.data.status, e.data.detail]);
    expect(statuses).toEqual([["connected", undefined], ["error", "boom"], ["connected", undefined]]);

    type.channels.at(-1)!.crash(new ChannelNeedsRelinkError("the token was revoked"));
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "needs_relink", "needs_relink");
    expect((await hub.list(dot.id))[0]!.status_detail).toBe("the token was revoked");
    const made = type.channels.length;
    await quiet();
    expect(type.channels.length).toBe(made);
  });

  it("reports a channel that cannot be made and tries again", async () => {
    const w = await world();
    const type = new FakeChannelType();
    type.createFailure = new Error("no network");
    const { hub } = await w.hub(type);
    const dot = await w.dot();
    await hub.add(dot.id, "telegram");
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "connected", "connected after the retry");
    expect((await eventsOf(dot.id, "channel.status")).map((e) => e.data.status)).toEqual(["error", "connected"]);
  });

  it("announces a status only when it changes, shortens a long reason and hides the credentials", async () => {
    const w = await world();
    const { hub, type } = await w.hub();
    const dot = await w.dot();
    await hub.add(dot.id, "telegram", { credentials: { telegram_bot_token: TOKEN } });
    const channel = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the channel");
    channel.sink!.status({ status: "connected", account: "fake_bot" });
    channel.sink!.status({ status: "error", detail: `GET https://api.test/bot${TOKEN}/getMe failed ` + "x".repeat(400) });
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "error", "the error");
    const [record] = await hub.list(dot.id);
    expect(record!.status_detail).toContain("[redacted]");
    expect(record!.status_detail!.length).toBeLessThanOrEqual(300);
    const logged = JSON.stringify(await db.events.list({ dotId: dot.id }));
    expect(logged).not.toContain("SECRET-TOKEN-VALUE");
    expect((await eventsOf(dot.id, "channel.status")).map((e) => e.data.status)).toEqual(["connected", "error"]);
    expect(record!.bot_username).toBe("fake_bot");
  });

  it("sends again after a failure that may pass, and drops a message the channel refuses for good", async () => {
    const w = await world();
    const { dot, channel, type } = await linked(w);
    type.sendFailures.push(new Error("network down"), new ChannelSendError("rate limited", { retryable: true, retryAfterMs: 5 }));
    dot.guest.emit("message.assistant", { text: "first" });
    await waitFor(() => channel.texts().includes("first"), "the retried message");
    expect(channel.texts()).toEqual(["first"]);

    type.sendFailures.push(new ChannelSendError("the bot was blocked", { retryable: false }));
    dot.guest.emit("message.assistant", { text: "refused" });
    dot.guest.emit("message.assistant", { text: "after" });
    await waitFor(() => channel.texts().includes("after"), "the message after the refused one");
    expect(channel.texts()).toEqual(["first", "after"]);
  });

  // Managing channels

  it("stores credentials encrypted and never returns them; unlinking deletes them with the people", async () => {
    const w = await world();
    const { hub, type } = await w.hub();
    const dot = await w.dot();
    const added = await hub.add(dot.id, "telegram", { credentials: { telegram_bot_token: TOKEN }, settings: { notify_tasks: false } });
    expect(JSON.stringify(added)).not.toContain("SECRET-TOKEN-VALUE");
    expect(added).toMatchObject({ kind: "telegram", enabled: true, settings: { approvals: true, notify_tasks: false }, peers: [] });
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBe(TOKEN);
    const raw = await db.query<{ value_enc: Uint8Array }>("SELECT value_enc FROM secrets WHERE scope = $1", [dot.id]);
    expect(Buffer.from(raw.rows[0]!.value_enc).includes(Buffer.from("SECRET-TOKEN"))).toBe(false);
    expect(JSON.stringify(await hub.list(dot.id))).not.toContain("SECRET-TOKEN-VALUE");

    const channel = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the channel");
    const { code } = await hub.pair(dot.id, "telegram");
    await channel.pair(code, "10");
    await hub.remove(dot.id, "telegram");
    expect(channel.sink).toBeNull();
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBeNull();
    expect(await hub.list(dot.id)).toEqual([]);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM channel_peers")).rows[0]!.n).toBe(0);
    await expect(hub.remove(dot.id, "telegram")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses what cannot be done, with the status the API answers", async () => {
    const w = await world();
    const { hub } = await w.hub();
    const dot = await w.dot();
    await hub.add(dot.id, "telegram");
    await expect(hub.add(dot.id, "telegram")).rejects.toMatchObject({ status: 409, code: "channel_exists" });
    await expect(hub.add("no-such-dot", "telegram")).rejects.toMatchObject({ status: 404 });
    const other = await w.dot();
    await expect(hub.add(other.id, "whatsapp" as ChannelKind)).rejects.toMatchObject({ status: 400 });
    await expect(hub.add(other.id, "telegram", { settings: { nope: true } })).rejects.toMatchObject({ status: 400 });
    await expect(hub.add(other.id, "telegram", { settings: { approvals: "yes" } })).rejects.toMatchObject({ status: 400 });
    await expect(hub.add(other.id, "telegram", { credentials: { wrong_name: "x" } })).rejects.toMatchObject({ status: 400 });
    await expect(hub.add(other.id, "telegram", { credentials: { telegram_bot_token: "" } })).rejects.toMatchObject({ status: 400 });
    expect(await hub.list(other.id)).toEqual([]);
    await expect(hub.setSettings(dot.id, "telegram", ["approvals"])).rejects.toMatchObject({ status: 400 });
    await expect(hub.pair(other.id, "telegram")).rejects.toMatchObject({ status: 404 });
    await hub.close();
    await expect(hub.add(other.id, "telegram")).rejects.toMatchObject({ status: 503 });
  });

  it("changes one setting and keeps the others", async () => {
    const w = await world();
    const { hub, dot } = await linked(w, []);
    expect((await hub.setSettings(dot.id, "telegram", { approvals: false })).settings).toEqual({ approvals: false, notify_tasks: true });
    expect((await hub.setSettings(dot.id, "telegram", { notify_tasks: false })).settings).toEqual({ approvals: false, notify_tasks: false });
    expect((await hub.list(dot.id))[0]!.settings).toEqual({ approvals: false, notify_tasks: false });
  });

  it("pauses a channel without losing its people, and a paused channel stays stopped across a restart", async () => {
    const w = await world();
    const { hub, dot, channel, type } = await linked(w, ["10"]);
    expect((await hub.setEnabled(dot.id, "telegram", false)).enabled).toBe(false);
    expect(channel.sink).toBeNull();

    const second = await w.hub();
    await quiet();
    expect(second.type.channels).toHaveLength(0);

    const resumed = await second.hub.setEnabled(dot.id, "telegram", true);
    expect(resumed.peers.map((p) => p.peer_id)).toEqual(["10"]);
    const channel2 = await waitFor(() => second.type.channels.at(-1)?.sink && second.type.channels.at(-1), "the channel again");
    dot.guest.emit("message.assistant", { text: "back" });
    await waitFor(() => channel2.texts("10").includes("back"), "a message to the person still paired");
    expect(type.channels).toHaveLength(1);
  });

  it("stops the channel and deletes everything when the Dot is deleted", async () => {
    const w = await world();
    const { hub, dot, channel, type } = await linked(w, ["10"]);
    await hub.close();
    await w.hub(type);
    const running = await waitFor(() => type.channels.at(-1)?.sink && type.channels.at(-1), "the channel");
    expect(running).not.toBe(channel);
    await db.secrets.put(dot.id, "telegram_bot_token", TOKEN);

    await w.scheduler.deleteDot(dot.id);
    await waitFor(() => running.sink === null, "the channel to stop");
    for (const table of ["channel_bindings", "channel_peers", "channel_pairings", "channel_inbound"]) {
      const column = table === "channel_bindings" ? "dot_id" : "binding_id";
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} IN (SELECT id FROM channel_bindings WHERE dot_id = $1) OR ${column} = $1`, [dot.id]);
      expect(rows[0]!.n).toBe(0);
    }
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBeNull();
  });

  it("leaves a binding of a kind this build has no adapter for stopped, and starts the others", async () => {
    const w = await world();
    const dot = await w.dot();
    const other = await w.dot();
    const withBoth = await w.hub(new FakeChannelType());
    await withBoth.hub.add(other.id, "telegram");
    await withBoth.hub.close();
    await db.channels.createBinding({ id: "chb_whatsapp_test", dotId: dot.id, kind: "whatsapp", settings: { approvals: true, notify_tasks: true }, eventCursor: 0 });
    const again = await w.hub(new FakeChannelType());
    await waitFor(() => again.type.channels.length === 1, "the telegram binding to start");
    expect((await again.hub.list(dot.id))[0]).toMatchObject({ kind: "whatsapp", status: "connecting" });
    await quiet();
    expect(again.type.channels).toHaveLength(1);
  });

  it("forgets handled messages older than the retention at start", async () => {
    const w = await world();
    const { dot, channel, hub } = await linked(w);
    await channel.receive({ externalId: "old-1", text: "old", peerId: "10", chatId: "10" });
    const binding = (await db.channels.binding(dot.id, "telegram"))!;
    expect(await db.channels.inboundMessageId(binding.id, "old-1")).not.toBeNull();
    await hub.close();
    const future = new ManualClock(new Date(Date.now() + 8 * 86_400_000));
    await w.hub(new FakeChannelType(), { clock: future });
    expect(await db.channels.inboundMessageId(binding.id, "old-1")).toBeNull();
  });
});
