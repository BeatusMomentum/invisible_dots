/**
 * The hub with the WhatsApp channel, with the real Scheduler, a fake guest and the fake WhatsApp connection:
 * linking by a code to scan, pairing by a message, a person talking to the Dot, answering an approval in words,
 * and what a stranger gets (nothing). The channel's own decisions are in whatsapp.test.ts.
 */
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { waitFor } from "@invisible-dots/scheduler/testing";
import type { ChannelLinkFrame } from "@invisible-dots/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BindingSecrets, WhatsAppChannelType, type ChannelHub } from "../src/index.js";
import { AuthStore, type BaileysAuthLib } from "../src/whatsapp-baileys/auth-state.js";
import { FakeChannelType, FakeWhatsAppConnector, type FakeWhatsAppConnection } from "../src/testing.js";
import { makeWorlds, quiet, type World } from "./world.js";

const ANN = "393331112222@s.whatsapp.net";
const ANN_LID = "99887766554433@lid";
const BEN = "393334445555@s.whatsapp.net";
const NUMBER = "15550001111";

describe.each(testAdapters())("the hub with the WhatsApp channel, with the real Scheduler and a fake guest (%s)", { timeout: 60_000 }, (kind) => {
  let t: TestDatabase;
  let db: Database;
  let world: ReturnType<typeof makeWorlds>["world"];
  let closeAll: ReturnType<typeof makeWorlds>["closeAll"];

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    ({ world, closeAll } = makeWorlds(db));
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
  }, 60_000);

  afterEach(async () => {
    await closeAll();
    await db.query("DELETE FROM channel_bindings");
    await db.query("DELETE FROM secrets WHERE name LIKE 'whatsapp_%'");
  });

  afterAll(async () => {
    await t?.drop();
  });

  /** A hub that runs WhatsApp on a fake connection (and Telegram on a fake channel, for the tests that need both). */
  async function whatsapp(w: World) {
    const connector = new FakeWhatsAppConnector();
    const type = new WhatsAppChannelType({ connector: () => connector, pauseMs: () => 0 });
    const telegram = new FakeChannelType();
    const { hub } = await w.hub(type, { types: [type, telegram] });
    return { hub, connector, type, telegram };
  }

  /** Collect the frames of a link until the stream ends. */
  async function watch(hub: ChannelHub, dotId: string) {
    const frames: ChannelLinkFrame[] = [];
    const controller = new AbortController();
    const stream = await hub.watchLink(dotId, "whatsapp", controller.signal);
    const done = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    return { frames, done, stop: () => controller.abort() };
  }

  /** A Dot with WhatsApp linked (the number scanned) and the given chats paired as owners. */
  async function linked(w: World, people: { chat: string; name?: string }[] = [{ chat: ANN, name: "Ann" }]) {
    const set = await whatsapp(w);
    const dot = await w.dot();
    await set.hub.link(dot.id, "whatsapp");
    await waitFor(() => set.connector.connections.length === 1, "the connection");
    const connection = () => set.connector.current;
    connection().open(NUMBER);
    await waitFor(async () => (await set.hub.list(dot.id))[0]?.status === "connected", "connected");
    for (const person of people) {
      const { code } = await set.hub.pair(dot.id, "whatsapp");
      connection().receive(person.chat, `pair ${code}`, person.name === undefined ? {} : { senderName: person.name });
      await waitFor(async () => (await set.hub.list(dot.id))[0]!.peers.length === people.indexOf(person) + 1, "the person to be paired");
    }
    await waitFor(() => connection().sent.length >= people.length, "the pairing notices");
    connection().sent.length = 0;
    // Answering a chat reads what it wrote; the pairing messages are not part of what a test looks at.
    connection().reads.length = 0;
    connection().typings.length = 0;
    return { ...set, dot, connection };
  }

  const userMessages = (dotId: string) => db.events.list({ dotId, types: ["user.message"] });

  // Linking

  it("starts a link: the binding waits, each code reaches the watcher, and the scan ends the stream with the number", async () => {
    const w = await world();
    const { hub, connector } = await whatsapp(w);
    const dot = await w.dot();
    const record = await hub.link(dot.id, "whatsapp");
    expect(record).toMatchObject({ kind: "whatsapp", enabled: true, status: "connecting", account: null, peers: [] });

    const watching = await watch(hub, dot.id);
    await waitFor(() => connector.connections.length === 1, "the connection");
    await waitFor(() => watching.frames.length === 1, "the first frame");
    connector.current.showCode("2@first-code");
    connector.current.showCode("2@second-code");
    connector.current.open(NUMBER);
    await watching.done;
    expect(watching.frames).toEqual([
      { state: "waiting" },
      { state: "code", code: "2@first-code" },
      { state: "code", code: "2@second-code" },
      { state: "linked", account: NUMBER },
    ]);
    expect((await hub.list(dot.id))[0]).toMatchObject({ status: "connected", account: NUMBER });
  });

  it("lets two Dots link the same phone: the number is no one's alone, each Dot is a device of its own", async () => {
    const w = await world();
    const { hub, connector } = await whatsapp(w);
    const first = await w.dot();
    const second = await w.dot();
    await hub.link(first.id, "whatsapp");
    await waitFor(() => connector.connections.length === 1, "the first connection");
    connector.current.open(NUMBER);
    await waitFor(async () => (await hub.list(first.id))[0]?.status === "connected", "the first Dot connected");

    await hub.link(second.id, "whatsapp");
    const watching = await watch(hub, second.id);
    await waitFor(() => connector.connections.length === 2, "the second connection");
    connector.current.open(NUMBER);
    await watching.done;
    expect(watching.frames.at(-1)).toEqual({ state: "linked", account: NUMBER });
    expect((await hub.list(second.id))[0]).toMatchObject({ status: "connected", account: NUMBER });
    expect((await hub.list(first.id))[0]).toMatchObject({ status: "connected", account: NUMBER });
  });

  it("gives a watcher that joins late the code on show now, not the history, and a linked channel straight away", async () => {
    const w = await world();
    const { hub, connector } = await whatsapp(w);
    const dot = await w.dot();
    await hub.link(dot.id, "whatsapp");
    await waitFor(() => connector.connections.length === 1, "the connection");
    connector.current.showCode("2@old");
    connector.current.showCode("2@current");
    const late = await watch(hub, dot.id);
    await waitFor(() => late.frames.length === 1, "the first frame");
    expect(late.frames).toEqual([{ state: "code", code: "2@current" }]);
    connector.current.open(NUMBER);
    await late.done;

    const after = await watch(hub, dot.id);
    await after.done;
    expect(after.frames).toEqual([{ state: "linked", account: NUMBER }]);
  });

  it("never stores or publishes the code: it is in no event, no status and no record", async () => {
    const w = await world();
    const { hub, connector } = await whatsapp(w);
    const dot = await w.dot();
    await hub.link(dot.id, "whatsapp");
    await waitFor(() => connector.connections.length === 1, "the connection");
    connector.current.showCode("2@SECRET-CODE-TO-SCAN");
    connector.current.open(NUMBER);
    await waitFor(async () => (await hub.list(dot.id))[0]?.status === "connected", "connected");
    const stored = JSON.stringify({ events: await db.events.list({ dotId: dot.id }), record: await hub.list(dot.id), rows: (await db.query("SELECT * FROM channel_bindings")).rows });
    expect(stored).not.toContain("SECRET-CODE-TO-SCAN");
  });

  it("ends the stream with the reason when the person has to start again, and again with a fresh start from nothing", async () => {
    const w = await world();
    const { hub, connector } = await whatsapp(w);
    const dot = await w.dot();
    await hub.link(dot.id, "whatsapp");
    await waitFor(() => connector.connections.length === 1, "the connection");
    const first = await watch(hub, dot.id);
    connector.current.end({ reason: "code_expired" });
    await first.done;
    expect(first.frames.at(-1)).toMatchObject({ state: "failed", detail: expect.stringMatching(/Start linking again/) });
    expect((await hub.list(dot.id))[0]).toMatchObject({ status: "needs_relink" });

    // A watcher that comes after the failure is told at once.
    const late = await watch(hub, dot.id);
    await late.done;
    expect(late.frames).toEqual([{ state: "failed", detail: expect.stringMatching(/Start linking again/) }]);

    // Linking again forgets the old device: its keys are deleted, the account is cleared, and a new connection shows a new code.
    await db.secrets.put(dot.id, "whatsapp_creds", "old-device-identity");
    await db.secrets.put(dot.id, "whatsapp_keys_session", "old-sessions");
    await hub.link(dot.id, "whatsapp");
    expect(await db.secrets.get(dot.id, "whatsapp_creds")).toBeNull();
    expect(await db.secrets.get(dot.id, "whatsapp_keys_session")).toBeNull();
    await waitFor(() => connector.connections.length === 2, "a new connection");
    const second = await watch(hub, dot.id);
    connector.current.showCode("2@new-code");
    connector.current.open("15550002222");
    await second.done;
    expect(second.frames.map((f) => f.state)).toEqual(["waiting", "code", "linked"]);
    expect((await hub.list(dot.id))[0]).toMatchObject({ status: "connected", account: "15550002222" });
  });

  it("goes on with a link that is waiting for its scan, instead of starting another connection", async () => {
    const w = await world();
    const { hub, connector } = await whatsapp(w);
    const dot = await w.dot();
    await hub.link(dot.id, "whatsapp");
    await waitFor(() => connector.connections.length === 1, "the connection");
    connector.current.showCode("2@shown");
    await hub.link(dot.id, "whatsapp");
    await quiet();
    expect(connector.connections).toHaveLength(1);
    const watching = await watch(hub, dot.id);
    await waitFor(() => watching.frames.length === 1, "the frame");
    expect(watching.frames).toEqual([{ state: "code", code: "2@shown" }]);
    watching.stop();
    await watching.done;
  });

  it("refuses to link a channel that is linked, and the refusal changes nothing", async () => {
    const w = await world();
    const { hub, dot, connector } = await linked(w);
    await expect(hub.link(dot.id, "whatsapp")).rejects.toMatchObject({ status: 409, code: "already_linked" });
    await quiet();
    expect(connector.connections).toHaveLength(1);
    expect((await hub.list(dot.id))[0]).toMatchObject({ status: "connected", account: NUMBER });
  });

  it("is linked by scanning, never by credentials, and a token channel is never linked by scanning", async () => {
    const w = await world();
    const { hub } = await whatsapp(w);
    const dot = await w.dot();
    await expect(hub.add(dot.id, "whatsapp")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/scanning a code/) });
    await expect(hub.setCredentials(dot.id, "whatsapp", {})).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/scanning a code/) });
    await expect(hub.link(dot.id, "telegram")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not by scanning/) });
    await expect(hub.watchLink(dot.id, "telegram", new AbortController().signal)).rejects.toMatchObject({ status: 400 });
    await expect(hub.watchLink(dot.id, "whatsapp", new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(await hub.list(dot.id)).toEqual([]);
  });

  it("says how to turn WhatsApp on when this server does not run it, and offers only the kinds it runs", async () => {
    const w = await world();
    const telegram = new FakeChannelType();
    const { hub } = await w.hub(telegram);
    const dot = await w.dot();
    expect(hub.kinds).toEqual(["telegram"]);
    await expect(hub.link(dot.id, "whatsapp")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/INVISIBLE_DOTS_WHATSAPP=1/) });
    const both = await whatsapp(w);
    expect(both.hub.kinds).toEqual(["whatsapp", "telegram"]);
  });

  it("deletes everything the linked device keeps when the channel is removed, and stops its connection", async () => {
    const w = await world();
    const { hub, dot, type, connection } = await linked(w);
    for (const name of type.secretNames) await db.secrets.put(dot.id, name, `${name}-value`);
    const before = connection();
    await hub.remove(dot.id, "whatsapp");
    for (const name of type.secretNames) expect(await db.secrets.get(dot.id, name)).toBeNull();
    expect(before.closed).toBe(true);
    expect(await hub.list(dot.id)).toEqual([]);
  });

  it("ends a link that is being watched when the channel is removed", async () => {
    const w = await world();
    const { hub, connector } = await whatsapp(w);
    const dot = await w.dot();
    await hub.link(dot.id, "whatsapp");
    await waitFor(() => connector.connections.length === 1, "the connection");
    const watching = await watch(hub, dot.id);
    await waitFor(() => watching.frames.length === 1, "the frame");
    await hub.remove(dot.id, "whatsapp");
    await watching.done;
    expect(watching.frames.at(-1)).toEqual({ state: "failed", detail: "The channel was removed." });
  });

  it("goes with the Dot: its binding, people and keys are gone, and the connection is stopped", async () => {
    const w = await world();
    const { dot, connection, type } = await linked(w);
    // The session the real adapter would hold open: its keys are written as they change, until the connection is closed.
    const binding = (await db.channels.listBindings(dot.id))[0]!;
    const auth = await AuthStore.open(dot.id, new BindingSecrets(db, binding.id), (await import("baileys")) as unknown as BaileysAuthLib);
    await auth.state.keys.set({ session: { a: Buffer.from("ratchet") } });
    await auth.saveCreds();
    for (const name of ["whatsapp_creds", "whatsapp_keys_session"]) expect(await db.secrets.get(dot.id, name)).not.toBeNull();
    const before = connection();
    await w.scheduler.deleteDot(dot.id);
    await waitFor(() => before.closed, "the connection to be closed");
    await waitFor(async () => (await db.channels.listBindings(dot.id)).length === 0, "the binding to go");
    // The session is still open here, as it is between the delete and the stop: whatever it writes now must not come back.
    await expect(auth.state.keys.set({ session: { b: Buffer.from("next ratchet") }, "pre-key": { "1": { public: Buffer.from("p"), private: Buffer.from("q") } } })).rejects.toThrow(/removed/);
    await expect(auth.saveCreds()).rejects.toThrow(/removed/);
    await auth.close();
    for (const name of type.secretNames) expect(await db.secrets.get(dot.id, name)).toBeNull();
    expect((await db.query("SELECT 1 FROM secrets WHERE scope = $1", [dot.id])).rows).toEqual([]);
  });

  // Pairing and talking

  it("pairs with the code in a message and gives a link and the words that carry it", async () => {
    const w = await world();
    const { hub, dot, connection } = await linked(w, []);
    const pairing = await hub.pair(dot.id, "whatsapp");
    expect(pairing.deep_link).toBe(`https://wa.me/${NUMBER}?text=pair%20${pairing.code}`);
    expect(pairing.message).toBe(`pair ${pairing.code}`);
    connection().receive(ANN, pairing.message, { senderName: "Ann" });
    await waitFor(async () => (await hub.list(dot.id))[0]!.peers.length === 1, "paired");
    expect((await hub.list(dot.id))[0]!.peers[0]).toMatchObject({ peer_id: "393331112222", role: "owner", label: "Ann (+393331112222)" });
    await waitFor(() => connection().sent.length === 1, "the notice");
    expect(connection().sent[0]).toMatchObject({ chat: ANN });
    expect(connection().sent[0]!.text).toMatch(/^Paired\./);
    // The code was used: the same words from someone else pair nobody.
    connection().receive(BEN, pairing.message);
    await quiet();
    expect((await hub.list(dot.id))[0]!.peers).toHaveLength(1);
  });

  it("carries a paired person's message to the Dot as plain text with its origin, and the answer back to the chat, after reading the message", async () => {
    const w = await world();
    const { dot, connection } = await linked(w);
    connection().receive(ANN, "hello", { id: "WAHELLO" });
    await waitFor(() => connection().texts(ANN).length === 1, "the answer");
    expect(connection().texts(ANN)).toEqual(["echo: hello"]);
    expect(dot.guest.inbound.at(-1)).toMatchObject({ type: "user.message", data: { text: "hello" } });
    expect(Object.keys(dot.guest.inbound.at(-1)!.data)).toEqual(["text"]);
    const [logged] = await userMessages(dot.id);
    expect(logged!.data.origin).toMatchObject({ channel: "whatsapp", chat_id: ANN, external_id: "393331112222:WAHELLO" });
    expect(connection().reads).toEqual([{ chat: ANN, id: "WAHELLO" }]);
  });

  it("is the same person whichever address WhatsApp uses: the phone, its LID with the phone beside it, or a LID the account knows", async () => {
    const w = await world();
    const { dot, connector, connection } = await linked(w);
    connection().receive(ANN_LID, "by the LID, phone beside it", { chatAlt: ANN });
    await waitFor(() => connection().texts(ANN).length === 1, "answer 1");
    connector.phonesByLid.set("99887766554433", "393331112222");
    connection().receive(ANN_LID, "by the LID the account learned");
    await waitFor(() => connection().texts(ANN).length === 2, "answer 2");
    expect(connection().texts(ANN)).toEqual(["echo: by the LID, phone beside it", "echo: by the LID the account learned"]);
    expect((await userMessages(dot.id)).every((e) => (e.data.origin as { chat_id: string }).chat_id === ANN)).toBe(true);
  });

  it("pairs and talks by the LID when nobody knows the number, and answers to the LID address", async () => {
    const w = await world();
    const { hub, dot, connection } = await linked(w, []);
    const { code } = await hub.pair(dot.id, "whatsapp");
    connection().receive("5544332211009@lid", `pair ${code}`, { senderName: "Hidden" });
    await waitFor(async () => (await hub.list(dot.id))[0]!.peers.length === 1, "paired");
    expect((await hub.list(dot.id))[0]!.peers[0]).toMatchObject({ peer_id: "lid:5544332211009", label: "Hidden" });
    await waitFor(() => connection().sent.length === 1, "the notice");
    connection().sent.length = 0;
    connection().receive("5544332211009@lid", "hi");
    await waitFor(() => connection().texts("5544332211009@lid").length === 1, "the answer");
    expect(connection().texts("5544332211009@lid")).toEqual(["echo: hi"]);
  });

  it("costs nothing and says nothing to a stranger: no row, no model event, no reply, no read receipt, no typing", async () => {
    const w = await world();
    const { hub, dot, connection } = await linked(w);
    for (let i = 0; i < 100; i++) {
      connection().receive(i % 2 === 0 ? BEN : "7788990011223@lid", `hello ${i}`);
      if (i % 10 === 0) connection().receive(BEN, "pair WRONGCODE");
      if (i % 10 === 1) connection().receive(BEN, "yes ap-abcdef");
    }
    await quiet(200);
    expect(connection().sent).toEqual([]);
    expect(connection().reads).toEqual([]);
    expect(connection().typings).toEqual([]);
    // Nothing reached the Dot: no message of the person's, nothing it answered.
    expect(await db.events.list({ dotId: dot.id, types: ["user.message", "message.assistant", "approval.resolved"] })).toEqual([]);
    expect((await hub.list(dot.id))[0]!.peers.map((p) => p.peer_id)).toEqual(["393331112222"]);
    expect(dot.guest.inbound.filter((e) => e.type === "user.message")).toEqual([]);
  });

  it("does not hand on what a paired person writes in a group or to itself", async () => {
    const w = await world();
    const { dot, connection } = await linked(w);
    connection().receive("120363000000000001@g.us", "in a group");
    connection().receive(ANN, "an own message", { fromMe: true });
    await quiet();
    expect(await userMessages(dot.id)).toEqual([]);
    expect(connection().sent).toEqual([]);
  });

  it("tells a paired person that attachments are not supported, and hands nothing on", async () => {
    const w = await world();
    const { dot, connection } = await linked(w);
    connection().receive(ANN, { kind: "attachment" });
    await waitFor(() => connection().sent.length === 1, "the notice");
    expect(connection().sent[0]).toMatchObject({ chat: ANN, text: "Attachments are not supported yet: send the message as text." });
    expect(await userMessages(dot.id)).toEqual([]);
  });

  it("sends an answer that answers nothing, such as an automation's, to every owner, never to a chat that did not pair", async () => {
    const w = await world();
    const { dot, connection } = await linked(w, [{ chat: ANN }, { chat: BEN }]);
    connection().receive("393339990000@s.whatsapp.net", "a stranger");
    dot.guest.emit("message.assistant", { text: "daily report" });
    await waitFor(() => connection().sent.length >= 2, "both owners");
    await quiet();
    expect(connection().sent.map((m) => [m.chat, m.text])).toEqual([
      [ANN, "daily report"],
      [BEN, "daily report"],
    ]);
  });

  // Approvals in words

  const received = (guest: { inbound: { type: string; data: unknown }[] }) => guest.inbound.filter((e) => e.type === "approval.received");
  const tokenOf = (approvalId: string) => `ap-${approvalId.slice(-6)}`;

  async function ask(dot: Awaited<ReturnType<World["dot"]>>, connection: () => FakeWhatsAppConnection) {
    const id = dot.guest.requestApproval(undefined, "exec");
    await waitFor(() => connection().sent.some((m) => m.text.includes(tokenOf(id))), "the prompt");
    return id;
  }

  it("asks with the words that answer, takes 'yes <code>' from the owner as the answer, and edits the prompt to the outcome", async () => {
    const w = await world();
    const { dot, connection } = await linked(w);
    const id = await ask(dot, connection);
    const prompt = connection().sent.find((m) => m.text.includes(tokenOf(id)))!;
    expect(prompt.chat).toBe(ANN);
    expect(prompt.text).toContain(`Reply "yes ${tokenOf(id)}" to approve or "no ${tokenOf(id)}" to reject.`);

    connection().receive(ANN, `Yes ${tokenOf(id).toUpperCase()}`);
    await waitFor(() => received(dot.guest).length === 1, "the decision at the guest");
    expect(received(dot.guest)[0]).toMatchObject({ data: { approval_id: id, decision: "approve" } });
    await waitFor(() => connection().sent.some((m) => m.text === "Approved."), "the notice");
    await waitFor(() => connection().edits.length === 1, "the prompt edited");
    expect(connection().edits[0]).toMatchObject({ chat: ANN, id: prompt.id });
    expect(connection().edits[0]!.text.endsWith("\n\nApproved.")).toBe(true);
    // It was an answer, not a message for the Dot.
    expect(await userMessages(dot.id)).toEqual([]);
  });

  it("rejects with 'no <code>'", async () => {
    const w = await world();
    const { dot, connection } = await linked(w);
    const id = await ask(dot, connection);
    connection().receive(ANN, `no ${tokenOf(id)}`);
    await waitFor(() => received(dot.guest).length === 1, "the decision");
    expect(received(dot.guest)[0]).toMatchObject({ data: { decision: "reject" } });
    await waitFor(() => connection().sent.some((m) => m.text === "Rejected."), "the notice");
  });

  it("does not take the answer of a stranger or of a person who is not an owner of this Dot, and the approval stays open", async () => {
    const w = await world();
    const { dot, connection } = await linked(w);
    const id = await ask(dot, connection);
    connection().receive(BEN, `yes ${tokenOf(id)}`);
    await quiet(100);
    expect(received(dot.guest)).toEqual([]);
    expect((await db.approvals.get(id))?.status).toBe("pending");
    expect(connection().sent.filter((m) => m.chat === BEN)).toEqual([]);
  });

  it("tells the owner when the code names nothing, when it was answered already, and when approvals are not asked in chats", async () => {
    const w = await world();
    const { hub, dot, connection } = await linked(w);
    const id = await ask(dot, connection);
    connection().receive(ANN, "yes ap-zzzzzz");
    await waitFor(() => connection().sent.some((m) => m.text === "That request does not exist."), "the notice for an unknown code");

    await w.scheduler.resolveApproval(id, "reject");
    connection().receive(ANN, `yes ${tokenOf(id)}`);
    await waitFor(() => connection().sent.some((m) => m.text === "It was answered already."), "the notice for a late answer");
    expect(received(dot.guest).filter((e) => (e.data as { decision: string }).decision === "approve")).toEqual([]);

    await hub.setSettings(dot.id, "whatsapp", { approvals: false });
    connection().receive(ANN, `yes ${tokenOf(id)}`);
    await waitFor(() => connection().sent.some((m) => m.text === "Approvals are not answered in this chat. Open the app to answer."), "the notice for approvals off");
  });

  it("says so when two approvals have the same code, and answers neither", async () => {
    const w = await world();
    const { dot, connection } = await linked(w);
    const data = (id: string) => ({ approval_id: id, tool: "exec", permission: "browser.identity.delete" as const, arguments: {}, reason: "test" });
    await db.approvals.insertRequested(dot.id, data("apr_aaaaaaaaaaaaaaaaaaaaaaaaaa111111"));
    await db.approvals.insertRequested(dot.id, data("apr_bbbbbbbbbbbbbbbbbbbbbbbbbb111111"));
    connection().receive(ANN, "yes ap-111111");
    await waitFor(() => connection().sent.some((m) => m.text === "Two requests have that code. Answer them in the app."), "the notice");
    expect((await db.approvals.get("apr_aaaaaaaaaaaaaaaaaaaaaaaaaa111111"))?.status).toBe("pending");
    expect((await db.approvals.get("apr_bbbbbbbbbbbbbbbbbbbbbbbbbb111111"))?.status).toBe("pending");
  });

  it("takes anything that is not exactly 'yes <code>' or 'no <code>' for an ordinary message to the Dot", async () => {
    const w = await world();
    const { dot, connection } = await linked(w);
    const id = await ask(dot, connection);
    for (const text of ["yes", "no", "yes 123456", `yes please ${tokenOf(id)}`, `${tokenOf(id)}`, `yes ${tokenOf(id)} thanks`]) connection().receive(ANN, text);
    await waitFor(() => connection().texts(ANN).filter((m) => m.startsWith("echo: ")).length === 6, "six answers from the Dot");
    expect(received(dot.guest)).toEqual([]);
    expect((await userMessages(dot.id)).length).toBe(6);
  });

  // The connection

  it("shows the connection's failures as status, retries a lost connection and stops at one that needs the person", async () => {
    const w = await world();
    const { hub, dot, connector, connection } = await linked(w);
    connection().end({ reason: "lost", detail: "Connection Closed (428)" });
    await waitFor(() => connector.connections.length === 2, "a new connection after the loss");
    const afterLoss = (await hub.list(dot.id))[0]!;
    expect(["error", "connecting"]).toContain(afterLoss.status);
    connection().open(NUMBER);
    await waitFor(async () => (await hub.list(dot.id))[0]?.status === "connected", "connected again");

    connection().end({ reason: "logged_out" });
    await waitFor(async () => (await hub.list(dot.id))[0]?.status === "needs_relink", "needs_relink");
    const record = (await hub.list(dot.id))[0]!;
    expect(record.status_detail).toMatch(/Linked devices/);
    await quiet(100);
    expect(connector.connections).toHaveLength(2);
    const statuses = (await db.events.list({ dotId: dot.id, types: ["channel.status"] })).map((e) => e.data.status);
    expect(statuses).toContain("needs_relink");
  });
});
