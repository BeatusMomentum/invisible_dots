import { newId, parseDotConfig, vmName, type OutboundEvent } from "@invisible-dots/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DotNameTakenError, TransactionMisuseError, type Database, type Repositories } from "../src/index.js";
import { createTestDatabase, testAdapters, type TestDatabase } from "../src/testing.js";

const SETUP_TIMEOUT = 60_000;

const yaml = (name: string) => `name: ${name}\ngoal: test goal\nmodel:\n  provider: openrouter\n  id: test/model\n`;

async function seedDot(r: Repositories, name: string) {
  const id = newId("dot");
  const dot = await r.dots.insert({ id, config: parseDotConfig(yaml(name)), status: "READY" });
  await r.computers.insert({ dotId: id, vmName: vmName(id), state: "RUNNING", token: `tok-${name}` });
  return dot;
}

function outbound(seq: number, type: OutboundEvent["type"], data: Record<string, unknown>): OutboundEvent {
  return { seq, id: `evt-${seq}`, type, ts: new Date().toISOString(), data } as OutboundEvent;
}

describe.each(testAdapters())("repositories on %s", { timeout: SETUP_TIMEOUT }, (kind) => {
  let t: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await t?.drop();
  }, SETUP_TIMEOUT);

  it("migrate is idempotent and records each version", async () => {
    expect(db.kind).toBe(kind);
    const again = await db.migrate();
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toContain("0001_initial");
    const { rows } = await db.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.map((r) => r.version)).toEqual(["0001_initial", "0002_inbound_events"]);
  });

  it("dots: unique names, resolve by id or name, status with error", async () => {
    const dot = await seedDot(db, "alpha");
    await expect(
      db.dots.insert({ id: newId("dot"), config: parseDotConfig(yaml("alpha")), status: "CREATING" }),
    ).rejects.toBeInstanceOf(DotNameTakenError);
    expect((await db.dots.resolve("alpha"))?.id).toBe(dot.id);
    expect((await db.dots.resolve(dot.id))?.computer_state).toBe("RUNNING");
    expect((await db.dots.get(dot.id))?.config.name).toBe("alpha");
    const errored = await db.dots.setStatus(dot.id, "ERROR", "boom");
    expect(errored?.error).toBe("boom");
    expect((await db.dots.setStatus(dot.id, "READY"))?.error).toBeNull();
    expect((await db.dots.list()).map((d) => d.name)).toContain("alpha");
  });

  it("computers: token stored encrypted, process recorded and cleared, cursor only moves forward", async () => {
    const dot = await seedDot(db, "bravo");
    const { rows } = await db.query<{ token_enc: Uint8Array }>("SELECT token_enc FROM computers WHERE dot_id = $1", [dot.id]);
    expect(Buffer.from(rows[0]!.token_enc).includes(Buffer.from("tok-bravo"))).toBe(false);
    expect(await db.computers.token(dot.id)).toBe("tok-bravo");

    const fresh = await db.computers.get(dot.id);
    expect(fresh).toMatchObject({ vm_name: `invisible-dot-${dot.id}`, guest_port: null, pid: null, event_cursor: 0 });
    expect(await db.computers.setProcess(dot.id, { pid: 4242, guestPort: 40123 })).toMatchObject({
      pid: 4242,
      guest_port: 40123,
    });
    expect(await db.computers.setProcess(dot.id, null)).toMatchObject({ pid: null, guest_port: null });
    await expect(db.computers.setProcess(dot.id, { pid: 1, guestPort: 70000 })).rejects.toMatchObject({ code: "23514" });

    await db.computers.advanceCursor(dot.id, 7, new Date("2030-01-01T00:00:00Z"));
    await db.computers.advanceCursor(dot.id, 3, new Date("2030-01-01T00:00:01Z"));
    const computer = await db.computers.get(dot.id);
    expect(computer?.event_cursor).toBe(7);
    expect(computer?.last_active_at).toBe("2030-01-01T00:00:01.000Z");
    expect((await db.computers.setState(dot.id, "ERROR", "qemu failed"))?.last_error).toBe("qemu failed");
    expect((await db.computers.setState(dot.id, "STOPPED"))?.last_error).toBe("qemu failed");
    expect((await db.computers.setState(dot.id, "RUNNING", null))?.last_error).toBeNull();
    await db.computers.setImages(dot.id, "golden-1", "runtime-1");
    expect(await db.computers.get(dot.id)).toMatchObject({ golden_image: "golden-1", runtime_image: "runtime-1" });
  });

  it("events: guest events are idempotent on (dot_id, guest_seq) and queries filter", async () => {
    const dot = await seedDot(db, "charlie");
    const first = await db.events.insertGuest(dot.id, outbound(1, "agent.state", { state: "THINKING" }));
    expect(first?.guest_seq).toBe(1);
    expect(typeof first?.id).toBe("number");
    expect(first?.data.guest_event_id).toBe("evt-1");
    expect(await db.events.insertGuest(dot.id, outbound(1, "agent.state", { state: "THINKING" }))).toBeNull();
    const host = await db.events.insertHost(dot.id, "computer.state", { state: "RUNNING" });
    expect(host.source).toBe("host");
    expect(host.guest_seq).toBeNull();
    const all = await db.events.list({ dotId: dot.id });
    expect(all.map((e) => e.type)).toEqual(["agent.state", "computer.state"]);
    expect(await db.events.list({ dotId: dot.id, after: first!.id })).toHaveLength(1);
    expect(await db.events.list({ dotId: dot.id, types: ["computer.state"] })).toHaveLength(1);
    expect((await db.events.tail(dot.id, 1))[0]?.id).toBe(host.id);
    expect(await db.events.latestId()).toBeGreaterThanOrEqual(host.id);
  });

  it("tasks: claim skips busy Dots, honours priority and scheduled_at, and never hands one Dot two tasks", async () => {
    const a = await seedDot(db, "delta");
    const b = await seedDot(db, "echo");
    const low = await db.tasks.insert({ id: newId("task"), dotId: a.id, description: "low", priority: 0 });
    const high = await db.tasks.insert({ id: newId("task"), dotId: a.id, description: "high", priority: 5 });
    await db.tasks.insert({
      id: newId("task"),
      dotId: b.id,
      description: "later",
      scheduledAt: new Date(Date.now() + 3_600_000),
    });

    // Two dispatchers race: only one task of Dot a may be claimed.
    const claims = await Promise.all([
      db.transaction((tx) => tx.tasks.claimNext()),
      db.transaction((tx) => tx.tasks.claimNext()),
    ]);
    const claimed = claims.filter((c) => c !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.task.id).toBe(high.id);
    expect(claimed[0]?.task.status).toBe("RUNNING");
    expect(claimed[0]?.run.delivered_at).toBeNull();
    // The claim stored the task.created for the guest in the same transaction.
    expect(claimed[0]?.inbound.event).toMatchObject({
      type: "task.created",
      data: { task_id: high.id, description: "high", priority: 5 },
    });
    expect((await db.inbound.pending(a.id)).map((r) => r.event.id)).toEqual([claimed[0]!.inbound.event.id]);

    // Dot a is busy and Dot b's task is not due.
    expect(await db.transaction((tx) => tx.tasks.claimNext())).toBeNull();
    expect(await db.tasks.hasWork(b.id, new Date())).toBe(false);
    expect(await db.tasks.hasWork(a.id, new Date())).toBe(true);
    expect((await db.tasks.activeForDot(a.id)).map((t) => t.id)).toEqual([high.id]);

    // Delivered: the run says so and nothing is pending any more.
    const sent = claimed[0]!.inbound.event.id;
    expect(await db.inbound.beginSend(sent)).toBe("send");
    await db.inbound.markDelivered(sent);
    expect((await db.tasks.runs(high.id))[0]?.delivered_at).not.toBeNull();
    expect(await db.inbound.pending(a.id)).toEqual([]);

    const done = await db.tasks.transition(high.id, "COMPLETED", { summary: "ok" });
    expect(done?.previous).toBe("RUNNING");
    expect(done?.task.status).toBe("COMPLETED");
    expect(done?.task.finished_at).not.toBeNull();
    expect((await db.tasks.runs(high.id)).at(-1)?.outcome).toBe("completed");
    // Terminal tasks do not move again, and a guest cannot move another Dot's task.
    expect(await db.tasks.transition(high.id, "FAILED", { error: "late" })).toBeNull();
    expect(await db.tasks.transition(low.id, "RUNNING", { dotId: b.id })).toBeNull();

    const next = await db.transaction((tx) => tx.tasks.claimNext());
    expect(next?.task.id).toBe(low.id);
    expect((await db.tasks.listByDot(a.id)).map((t) => t.id)).toContain(low.id);
    expect((await db.tasks.listByDot(a.id, { status: "COMPLETED" })).map((t) => t.id)).toEqual([high.id]);
  });

  it("inbound: a cancel and a send of the same task.created decide atomically who wins", async () => {
    const dot = await seedDot(db, "kilo");
    const event = (id: string) =>
      ({ id, type: "task.created", ts: new Date().toISOString(), data: { task_id: "x", description: "d", priority: 0 } }) as const;

    // The cancel wins: the send that comes after finds the row dropped and the task ended.
    const first = await db.tasks.insert({ id: newId("task"), dotId: dot.id, description: "first" });
    await db.tasks.transition(first.id, "RUNNING");
    await db.inbound.enqueue(dot.id, event("evt_first"), { taskId: first.id });
    await db.tasks.transition(first.id, "CANCELLED");
    expect(await db.inbound.dropUnsent(first.id, "cancelled")).toBe(true);
    expect(await db.inbound.beginSend("evt_first")).toBe("skip");

    // The send wins: the cancel finds a row the guest may hold, so it must tell the guest.
    const second = await db.tasks.insert({ id: newId("task"), dotId: dot.id, description: "second" });
    await db.tasks.transition(second.id, "RUNNING");
    await db.inbound.enqueue(dot.id, event("evt_second"), { taskId: second.id });
    expect(await db.inbound.beginSend("evt_second")).toBe("send");
    await db.tasks.transition(second.id, "CANCELLED");
    expect(await db.inbound.dropUnsent(second.id, "cancelled")).toBe(false);
    // Its retry is never sent again for a task that ended: it is dropped instead.
    expect(await db.inbound.beginSend("evt_second")).toBe("skip");
    expect((await db.inbound.get("evt_second"))?.dropped_at).not.toBeNull();
    expect(await db.inbound.pending(dot.id)).toEqual([]);
  });

  it("inbound: rows wait in order, failures count, and only due rows are retried", async () => {
    const dot = await seedDot(db, "lima");
    const message = (id: string) => ({ id, type: "user.message", ts: new Date().toISOString(), data: { text: id } }) as const;
    await db.inbound.enqueue(dot.id, message("evt_m1"));
    await db.inbound.enqueue(dot.id, message("evt_m2"));
    expect((await db.inbound.pending(dot.id)).map((r) => r.event.id)).toEqual(["evt_m1", "evt_m2"]);
    expect(await db.tasks.hasWork(dot.id, new Date())).toBe(true);
    expect(await db.inbound.dueDots(3)).toContain(dot.id);
    expect(await db.inbound.recordFailure("evt_m1", "refused", new Date(Date.now() + 3_600_000))).toBe(1);
    expect(await db.inbound.recordFailure("evt_m2", "refused", new Date(Date.now() + 3_600_000))).toBe(1);
    expect(await db.inbound.dueDots(3)).not.toContain(dot.id);
    await db.inbound.markDelivered("evt_m1");
    await db.inbound.markDelivered("evt_m2");
    expect(await db.tasks.hasWork(dot.id, new Date())).toBe(false);
  });

  it("ending a task expires its pending approvals; a request for an ended task is never pending", async () => {
    const dot = await seedDot(db, "mike");
    const task = await db.tasks.insert({ id: newId("task"), dotId: dot.id, description: "asks" });
    await db.tasks.transition(task.id, "RUNNING");
    const request = (approvalId: string) => ({
      approval_id: approvalId,
      task_id: task.id,
      tool: "files_write",
      permission: "files.write" as const,
      arguments: {},
      reason: "needs a decision",
    });
    await db.approvals.insertRequested(dot.id, request("apr_waiting"));
    const cancelled = await db.tasks.transition(task.id, "CANCELLED");
    expect(cancelled?.previous).toBe("RUNNING");
    expect((await db.approvals.get("apr_waiting"))?.status).toBe("expired");
    expect((await db.approvals.list({ status: "pending", dotId: dot.id })).map((a) => a.id)).toEqual([]);
    expect(await db.approvals.resolve("apr_waiting", "approved", null)).toBeNull();
    expect((await db.approvals.insertRequested(dot.id, request("apr_late"), "expired"))?.status).toBe("expired");
  });

  it("event ids become visible in id order: an insert waits for a transaction that drew a lower id", async () => {
    const dot = await seedDot(db, "november");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lowId = 0;
    const slow = db.transaction(async (tx) => {
      lowId = (await tx.events.insertGuest(dot.id, outbound(1, "memory.written", { key: "slow" })))!.id;
      await held;
    });
    // Let the transaction draw its id before the autocommit insert starts.
    while (lowId === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    let highDone = false;
    const fast = db.events.insertHost(dot.id, "computer.started", {}).then((event) => {
      highDone = true;
      return event;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Committing 11 before 10 would let a stream resumed after 11 skip 10 for good.
    expect(highDone).toBe(false);
    release();
    await slow;
    expect((await fast).id).toBeGreaterThan(lowId);
  });

  it("one server per database: the instance lock is held for the life of the handle", async () => {
    expect(await db.holdInstanceLock()).toBe(true);
    if (kind === "pg") {
      const { Database } = await import("../src/index.js");
      const second = await Database.open({ target: { kind: "pg", url: t.url! }, masterKey: new Uint8Array(32) });
      try {
        expect(await second.holdInstanceLock()).toBe(false);
      } finally {
        await second.close();
      }
    }
  });

  it("approvals: replayed requests are ignored and a resolution happens once", async () => {
    const dot = await seedDot(db, "foxtrot");
    const data = {
      approval_id: newId("apr"),
      tool: "browser_identity_delete",
      permission: "browser.identity.delete" as const,
      arguments: { identity_id: "x-abc123" },
      reason: "cleanup",
    };
    expect((await db.approvals.insertRequested(dot.id, data))?.status).toBe("pending");
    expect(await db.approvals.insertRequested(dot.id, data)).toBeNull();
    expect((await db.approvals.get(data.approval_id))?.arguments).toEqual({ identity_id: "x-abc123" });
    expect((await db.approvals.list({ status: "pending", dotId: dot.id })).map((a) => a.id)).toEqual([data.approval_id]);
    expect((await db.approvals.resolve(data.approval_id, "approved", "fine"))?.note).toBe("fine");
    expect(await db.approvals.resolve(data.approval_id, "rejected", null)).toBeNull();
  });

  it("secrets: encrypted at rest, per-Dot key wins over the global one", async () => {
    const dot = await seedDot(db, "golf");
    expect(await db.secrets.openRouterKey(dot.id)).toBeNull();
    await db.secrets.put("global", "openrouter_api_key", "sk-global");
    expect(await db.secrets.openRouterKey(dot.id)).toBe("sk-global");
    await db.secrets.put(dot.id, "openrouter_api_key", "sk-dot");
    await db.secrets.put(dot.id, "openrouter_api_key", "sk-dot-2");
    expect(await db.secrets.openRouterKey(dot.id)).toBe("sk-dot-2");
    const { rows } = await db.query<{ value_enc: Uint8Array }>("SELECT value_enc FROM secrets");
    for (const row of rows) expect(Buffer.from(row.value_enc).toString("latin1")).not.toContain("sk-");
    expect(await db.secrets.delete(dot.id, "openrouter_api_key")).toBe(true);
    expect(await db.secrets.openRouterKey(dot.id)).toBe("sk-global");
    expect(await db.holdsEncryptedValues()).toBe(true);
  });

  it("deleting a Dot cascades to its computer, tasks and approvals but keeps its events", async () => {
    const dot = await seedDot(db, "hotel");
    await db.tasks.insert({ id: newId("task"), dotId: dot.id, description: "x" });
    await db.events.insertHost(dot.id, "dot.deleted", { name: "hotel" });
    expect(await db.dots.delete(dot.id)).toBe(true);
    expect(await db.computers.get(dot.id)).toBeNull();
    expect(await db.tasks.listByDot(dot.id)).toEqual([]);
    expect(await db.events.list({ dotId: dot.id })).toHaveLength(1);
  });

  it("a transaction rolls back when its function throws, and refuses the outer repositories inside it", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.dots.insert({ id: newId("dot"), config: parseDotConfig(yaml("india")), status: "CREATING" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.dots.resolve("india")).toBeNull();
    await expect(db.transaction(() => db.dots.list())).rejects.toBeInstanceOf(TransactionMisuseError);
  });
});

describe.each(testAdapters())("an empty database on %s", { timeout: SETUP_TIMEOUT }, (kind) => {
  it("holds no encrypted values", async () => {
    const t = await createTestDatabase(kind);
    try {
      expect(await t.db.holdsEncryptedValues()).toBe(false);
    } finally {
      await t.drop();
    }
  });
});
