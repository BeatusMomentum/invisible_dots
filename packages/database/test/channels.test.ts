import { newId, parseDotConfig } from "@invisible-dots/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isUniqueViolation, type Database } from "../src/index.js";
import { createTestDatabase, testAdapters, type TestDatabase } from "../src/testing.js";

const SETUP_TIMEOUT = 60_000;
const settings = { approvals: true, notify_tasks: true };
const yaml = (name: string) => `name: ${name}\ngoal: test goal\nmodel:\n  provider: openrouter\n  id: test/model\n`;

describe.each(testAdapters())("channel repository on %s", { timeout: SETUP_TIMEOUT }, (kind) => {
  let t: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await t?.drop();
  }, SETUP_TIMEOUT);

  async function binding(name: string, eventCursor = 0) {
    const dot = await db.dots.insert({ id: newId("dot"), config: parseDotConfig(yaml(name)), status: "READY" });
    const record = await db.channels.createBinding({ id: newId("chb"), dotId: dot.id, kind: "telegram", settings, eventCursor });
    return { dot, record };
  }

  it("a Dot has one binding per kind, found by Dot and kind or by id", async () => {
    const { dot, record } = await binding("chan-one", 12);
    expect(record).toMatchObject({ dot_id: dot.id, kind: "telegram", enabled: true, status: "connecting", status_detail: null, account: null, event_cursor: 12, settings });
    await expect(db.channels.createBinding({ id: newId("chb"), dotId: dot.id, kind: "telegram", settings, eventCursor: 0 })).rejects.toSatisfy(isUniqueViolation);
    expect((await db.channels.binding(dot.id, "telegram"))?.id).toBe(record.id);
    expect(await db.channels.binding(dot.id, "whatsapp")).toBeNull();
    expect((await db.channels.bindingById(record.id))?.dot_id).toBe(dot.id);
    expect((await db.channels.listBindings(dot.id)).map((b) => b.id)).toEqual([record.id]);
    expect((await db.channels.listBindings()).map((b) => b.id)).toContain(record.id);
  });

  it("a binding made with a checked account has its name from the start, and the account stays when the status changes", async () => {
    const dot = await db.dots.insert({ id: newId("dot"), config: parseDotConfig(yaml("chan-account")), status: "READY" });
    const record = await db.channels.createBinding({ id: newId("chb"), dotId: dot.id, kind: "telegram", settings, eventCursor: 0, account: "my_bot" });
    expect(record).toMatchObject({ account: "my_bot", status: "connecting" });
    expect(await db.channels.setStatus(record.id, "connected", null)).toBe(true);
    expect((await db.channels.bindingById(record.id))?.account).toBe("my_bot");
  });

  it("settings and enabled are stored; the status reports a change once; the cursor never moves back", async () => {
    const { record } = await binding("chan-two");
    expect((await db.channels.setSettings(record.id, { approvals: false, notify_tasks: true }))?.settings).toEqual({ approvals: false, notify_tasks: true });
    expect((await db.channels.setEnabled(record.id, false))?.enabled).toBe(false);

    expect(await db.channels.setStatus(record.id, "connecting", null)).toBe(false);
    expect(await db.channels.setStatus(record.id, "connected", null, "my_bot")).toBe(true);
    expect(await db.channels.setStatus(record.id, "connected", null, "my_bot")).toBe(false);
    expect(await db.channels.setStatus(record.id, "error", "no network")).toBe(true);
    expect(await db.channels.bindingById(record.id)).toMatchObject({ status: "error", status_detail: "no network", account: "my_bot" });

    await db.channels.advanceCursor(record.id, 9);
    await db.channels.advanceCursor(record.id, 4);
    expect((await db.channels.bindingById(record.id))?.event_cursor).toBe(9);
  });

  it("peers: added, updated in place, found by chat, removed", async () => {
    const { record } = await binding("chan-three");
    const base = { bindingId: record.id, peerId: "42", chatId: "42", role: "owner" as const, label: "Ada" };
    const first = await db.channels.upsertPeer(base);
    const again = await db.channels.upsertPeer({ ...base, chatId: "99", label: "Ada L." });
    expect(again).toMatchObject({ chat_id: "99", label: "Ada L.", role: "owner", created_at: first.created_at });
    expect((await db.channels.peerByChat(record.id, "99"))?.peer_id).toBe("42");
    expect(await db.channels.peerByChat(record.id, "42")).toBeNull();
    expect((await db.channels.peer(record.id, "42"))?.label).toBe("Ada L.");
    expect((await db.channels.peers(record.id)).map((p) => p.peer_id)).toEqual(["42"]);
    expect(await db.channels.deletePeer(record.id, "42")).toBe(true);
    expect(await db.channels.deletePeer(record.id, "42")).toBe(false);
    expect(await db.channels.peers(record.id)).toEqual([]);
  });

  it("a pairing code works once, before it expires, and expired ones are cleared by the next code", async () => {
    const { record } = await binding("chan-four");
    const now = new Date("2030-01-01T00:00:00Z");
    const later = new Date("2030-01-01T00:10:00Z");
    await db.channels.createPairing(record.id, "hash-a", later, now);
    expect(await db.channels.consumePairing(record.id, "hash-wrong", now)).toBe(false);
    expect(await db.channels.consumePairing(record.id, "hash-a", new Date("2030-01-01T00:10:00Z"))).toBe(false);
    expect(await db.channels.consumePairing(record.id, "hash-a", new Date("2030-01-01T00:09:59Z"))).toBe(true);
    expect(await db.channels.consumePairing(record.id, "hash-a", now)).toBe(false);
    await db.channels.createPairing(record.id, "hash-b", later, new Date("2030-01-02T00:00:00Z"));
    const { rows } = await db.query<{ code_hash: string }>("SELECT code_hash FROM channel_pairings WHERE binding_id = $1", [record.id]);
    expect(rows.map((r) => r.code_hash)).toEqual(["hash-b"]);
  });

  it("an inbound message is recorded once by its channel id, and old records are pruned", async () => {
    const { record } = await binding("chan-five");
    expect(await db.channels.inboundMessageId(record.id, "u1")).toBeNull();
    await db.channels.recordInbound(record.id, "u1", "msg_1");
    await db.channels.recordInbound(record.id, "u1", "msg_2");
    expect(await db.channels.inboundMessageId(record.id, "u1")).toBe("msg_1");
    expect(await db.channels.pruneInbound(new Date(Date.now() - 3_600_000))).toBe(0);
    expect(await db.channels.pruneInbound(new Date(Date.now() + 3_600_000))).toBeGreaterThanOrEqual(1);
    expect(await db.channels.inboundMessageId(record.id, "u1")).toBeNull();
  });

  it("deleting a binding deletes its peers, codes and inbound record; deleting the Dot deletes the binding", async () => {
    const { dot, record } = await binding("chan-six");
    await db.channels.upsertPeer({ bindingId: record.id, peerId: "1", chatId: "1", role: "owner", label: "A" });
    await db.channels.createPairing(record.id, "h", new Date(Date.now() + 60_000), new Date());
    await db.channels.recordInbound(record.id, "u", "msg_x");
    expect(await db.channels.deleteBinding(record.id)).toBe(true);
    expect(await db.channels.deleteBinding(record.id)).toBe(false);
    for (const table of ["channel_peers", "channel_pairings", "channel_inbound"]) {
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE binding_id = $1`, [record.id]);
      expect(rows[0]!.n).toBe(0);
    }

    const second = await db.channels.createBinding({ id: newId("chb"), dotId: dot.id, kind: "whatsapp", settings, eventCursor: 0 });
    await db.channels.upsertPeer({ bindingId: second.id, peerId: "2", chatId: "2", role: "owner", label: "B" });
    await db.dots.delete(dot.id);
    expect(await db.channels.bindingById(second.id)).toBeNull();
    expect(await db.channels.peers(second.id)).toEqual([]);
  });

  it("keeps the approval prompts a binding sent: one per chat, found by approval or all, deleted one by one", async () => {
    const { dot, record } = await binding("chan-prompts");
    const first = newId("appr");
    const second = newId("appr");
    for (const id of [first, second]) {
      await db.approvals.insertRequested(dot.id, { approval_id: id, tool: "exec", permission: "browser.identity.delete", arguments: {}, reason: "r" });
    }
    await db.channels.addPrompt(record.id, first, "10", "m1");
    await db.channels.addPrompt(record.id, first, "20", "m2");
    await db.channels.addPrompt(record.id, second, "10", "m3");
    // Sending the same approval to the same chat again keeps the first message.
    await db.channels.addPrompt(record.id, first, "10", "m-again");

    expect((await db.channels.prompts(record.id, first)).map((p) => [p.chat_id, p.ref])).toEqual([
      ["10", "m1"],
      ["20", "m2"],
    ]);
    expect((await db.channels.prompts(record.id)).map((p) => p.approval_id).sort()).toEqual([first, first, second].sort());
    expect(await db.channels.prompts(record.id, "appr_other")).toEqual([]);

    await db.channels.deletePrompt(record.id, first, "10");
    expect((await db.channels.prompts(record.id, first)).map((p) => p.chat_id)).toEqual(["20"]);
    await db.channels.deletePrompt(record.id, first, "10");
    expect(await db.channels.prompts(record.id)).toHaveLength(2);
  });

  it("deletes the prompts with their binding, and with the Dot whose approval they ask about", async () => {
    const one = await binding("chan-prompts-binding");
    const asked = newId("appr");
    await db.approvals.insertRequested(one.dot.id, { approval_id: asked, tool: "exec", permission: "browser.identity.delete", arguments: {}, reason: "r" });
    await db.channels.addPrompt(one.record.id, asked, "10", "m1");
    await db.channels.deleteBinding(one.record.id);
    const left = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM channel_prompts WHERE approval_id = $1", [asked]);
    expect(left.rows[0]!.n).toBe(0);
    expect(await db.approvals.get(asked)).not.toBeNull();

    const two = await binding("chan-prompts-dot");
    const other = newId("appr");
    await db.approvals.insertRequested(two.dot.id, { approval_id: other, tool: "exec", permission: "browser.identity.delete", arguments: {}, reason: "r" });
    await db.channels.addPrompt(two.record.id, other, "10", "m1");
    await db.dots.delete(two.dot.id);
    const gone = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM channel_prompts WHERE approval_id = $1", [other]);
    expect(gone.rows[0]!.n).toBe(0);
  });
});
