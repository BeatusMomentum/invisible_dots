import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONVERSATION_THREAD, DotStore } from "../src/index.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "idots-store-"));
  dirs.push(dir);
  return join(dir, "state", "dot.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DotStore", () => {
  it("creates the directory, applies the migrations once and reopens", () => {
    const path = tempDb();
    const a = DotStore.open(path);
    expect(a.schemaVersion()).toBe(1);
    a.setConfig("runtime", { name: "x" });
    a.close();
    const b = DotStore.open(path);
    expect(b.schemaVersion()).toBe(1);
    expect(b.getConfig("runtime")).toEqual({ name: "x" });
    b.close();
  });

  it("keeps outbox seq monotonic across restarts and replays after a seq", () => {
    const path = tempDb();
    const a = DotStore.open(path);
    const e1 = a.appendEvent("agent.state", { state: "THINKING" });
    const e2 = a.appendEvent("message.assistant", { text: "hi" });
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    a.close();

    const b = DotStore.open(path);
    expect(b.lastSeq()).toBe(2);
    const e3 = b.appendEvent("memory.written", { key: "k" });
    expect(e3.seq).toBe(3);
    expect(b.readAfter(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(b.readAfter(0, 2).map((e) => e.type)).toEqual(["agent.state", "message.assistant"]);
    expect(b.readAfter(3)).toEqual([]);
    expect(b.readAfter(0)[1]).toMatchObject({ type: "message.assistant", data: { text: "hi" } });
    b.close();
  });

  it("notifies subscribers after the row is written and survives a throwing one", () => {
    const store = new DotStore({ path: ":memory:" });
    const seen: number[] = [];
    store.subscribe(() => {
      throw new Error("broken subscriber");
    });
    const off = store.subscribe((e) => {
      seen.push(e.seq);
      expect(store.readAfter(e.seq - 1)[0]?.seq).toBe(e.seq);
    });
    store.appendEvent("agent.state", { state: "IDLE" });
    off();
    store.appendEvent("agent.state", { state: "THINKING" });
    expect(seen).toEqual([1]);
    store.close();
  });

  it("hands events written in a transaction to subscribers only after COMMIT, and never a rolled back one", () => {
    const store = new DotStore({ path: ":memory:" });
    const seen: { seq: number; committed: boolean }[] = [];
    store.subscribe((e) => seen.push({ seq: e.seq, committed: store.readAfter(e.seq - 1)[0]?.seq === e.seq }));
    expect(() =>
      store.transaction(() => {
        store.appendEvent("task.completed", { task_id: "t1", summary: "never happened" });
        throw new Error("a later statement of the transaction failed");
      }),
    ).toThrow("a later statement");
    // Nothing streamed, and the seq the rolled back event had goes to the next one.
    expect(seen).toEqual([]);
    store.transaction(() => {
      store.appendEvent("approval.requested", {
        approval_id: "a1",
        tool: "files_write",
        permission: "files.write",
        arguments: {},
        reason: "r",
      });
      // Inside the transaction nothing is handed over yet.
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([{ seq: 1, committed: true }]);
    expect(store.readAfter(0).map((e) => e.type)).toEqual(["approval.requested"]);
    store.close();
  });

  it("stores thread messages and returns the last N in order", () => {
    const store = new DotStore({ path: ":memory:" });
    for (let i = 0; i < 5; i++) store.appendMessage(CONVERSATION_THREAD, { role: "user", content: `m${i}` });
    store.appendMessage("task_1", { role: "user", content: "other thread" });
    expect(store.countMessages(CONVERSATION_THREAD)).toBe(5);
    expect(store.listMessages(CONVERSATION_THREAD, { limit: 2 }).map((m) => m.message.content)).toEqual(["m3", "m4"]);
    expect(store.listMessages("task_1")).toHaveLength(1);
    store.close();
  });

  it("accepts an inbound event id once and tracks what is still unhandled", () => {
    const store = new DotStore({ path: ":memory:" });
    const ev = { id: "in_1", type: "user.message" as const, ts: "2026-01-01T00:00:00Z", data: { text: "hello" } };
    expect(store.acceptInbound(ev)).toBe(true);
    expect(store.acceptInbound(ev)).toBe(false);
    store.acceptInbound({ ...ev, id: "in_2" });
    expect(store.pendingInbound().map((e) => e.id)).toEqual(["in_1", "in_2"]);
    store.markInboundProcessed("in_1");
    expect(store.pendingInbound(["user.message"]).map((e) => e.id)).toEqual(["in_2"]);
    expect(store.pendingInbound(["task.created"])).toEqual([]);
    store.close();
  });

  it("orders tasks by priority then creation, and patches them", () => {
    const store = new DotStore({ path: ":memory:" });
    store.insertTask({ id: "t1", description: "low", priority: 0 });
    store.insertTask({ id: "t2", description: "high", priority: 5 });
    store.insertTask({ id: "t3", description: "low again", priority: 0 });
    expect(store.insertTask({ id: "t1", description: "dup", priority: 9 }).created).toBe(false);
    expect(store.listTasks().map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
    const done = store.updateTask("t2", {
      status: "COMPLETED",
      summary: "ok",
      usage: { prompt_tokens: 1, completion_tokens: 2, cost: null, requests: 1 },
    });
    expect(done).toMatchObject({ status: "COMPLETED", summary: "ok", usage: { completion_tokens: 2 } });
    expect(store.listTasks({ status: ["PENDING"] }).map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(() => store.updateTask("missing", { status: "FAILED" })).toThrow(/no task/);
    store.close();
  });

  it("searches memories with FTS5, survives FTS syntax in the query and lists recent keys", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = new DotStore({ path: ":memory:", now: () => new Date((clock += 1000)) });
    store.remember("fares-lisbon", "Cheapest one-way fare Milan to Lisbon was 39 EUR on Tuesday");
    store.remember("login-notes", "The airline site asks for a code by email");
    store.remember("fares-lisbon", "Cheapest fare is now 35 EUR on Wednesday");
    expect(store.searchMemories("lisbon").map((h) => h.key)).toEqual(["fares-lisbon"]);
    expect(store.searchMemories("Wednes")[0]?.content).toContain("35 EUR");
    expect(store.searchMemories("Tuesday")).toEqual([]);
    expect(store.searchMemories('airline" OR (NEAR')[0]?.key).toBe("login-notes");
    expect(store.searchMemories("   ")).toEqual([]);
    expect(store.recentMemoryKeys(20)).toEqual(["fares-lisbon", "login-notes"]);
    expect(store.forget("login-notes")).toBe(true);
    expect(store.searchMemories("airline")).toEqual([]);
    store.close();
  });

  it("persists pending approvals and resolves each once", () => {
    const store = new DotStore({ path: ":memory:" });
    store.insertPendingApproval({
      approvalId: "apr_1",
      thread: "t1",
      taskId: "t1",
      toolCallId: "call_1",
      tool: "browser_identity_delete",
      permission: "browser.identity.delete",
      arguments: { identity_id: "a-123456" },
      reason: "needs approval",
    });
    expect(store.listApprovals({ status: "pending" })).toHaveLength(1);
    expect(store.getApprovalByToolCall("call_1")?.approvalId).toBe("apr_1");
    expect(store.resolveApproval("apr_1", "rejected", "no")).toBe(true);
    expect(store.resolveApproval("apr_1", "approved")).toBe(false);
    expect(store.getApproval("apr_1")).toMatchObject({ status: "rejected", note: "no" });
    store.deleteApproval("apr_1");
    expect(store.getApproval("apr_1")).toBeUndefined();
    store.close();
  });

  it("stores browser identities with the optional proxy", () => {
    const store = new DotStore({ path: ":memory:" });
    store.putIdentity({
      id: "shop-abc123",
      name: "Shop",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      status: "available",
      profilePath: "/home/dot/browsers/shop-abc123/profile",
    });
    store.putIdentity({
      id: "shop-abc123",
      name: "Shop",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-02T00:00:00.000Z",
      status: "open",
      profilePath: "/home/dot/browsers/shop-abc123/profile",
      proxy: "http://proxy.invalid:8080",
    });
    expect(store.listIdentities()).toEqual([
      {
        id: "shop-abc123",
        name: "Shop",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-02T00:00:00.000Z",
        status: "open",
        profilePath: "/home/dot/browsers/shop-abc123/profile",
        proxy: "http://proxy.invalid:8080",
      },
    ]);
    store.deleteIdentity("shop-abc123");
    expect(store.getIdentity("shop-abc123")).toBeUndefined();
    store.close();
  });

  it("rolls a failed transaction back", () => {
    const store = new DotStore({ path: ":memory:" });
    expect(() =>
      store.transaction(() => {
        store.setConfig("a", 1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getConfig("a")).toBeUndefined();
    store.close();
  });
});
