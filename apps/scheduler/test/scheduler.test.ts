import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import type { Automation, StoredEvent } from "@invisible-dots/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Scheduler, type SchedulerOptions } from "../src/index.js";
import { FakeDriver, FakeGuestError, ManualClock, waitFor, waitUntilSettledReady } from "../src/testing.js";


const yaml = (name: string, idle = "15m") =>
  `name: ${name}\ngoal: keep watch\nmodel:\n  provider: openrouter\n  id: test/model\ncomputer:\n  idle_timeout: ${idle}\n`;

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: "job_1",
  name: "daily fares",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Rome" },
  message: "check the fares",
  next_run_at_ms: 1_800_000_000_000,
  last_run_at_ms: null,
  last_status: null,
  last_error: null,
  delete_after_run: false,
  created_at_ms: 1_700_000_000_000,
  ...over,
});

describe.each(testAdapters())("Scheduler with a fake driver and a fake guest (%s)", (kind) => {
  let t: TestDatabase;
  let db: Database;
  const open: Scheduler[] = [];

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  afterAll(async () => {
    await t?.drop();
  });

  function make(driver = new FakeDriver(), extra: Partial<SchedulerOptions> = {}) {
    const clock = new ManualClock();
    const scheduler = new Scheduler({
      db,
      driver,
      clock,
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10, pumpMaxRetryMs: 50 },
      dispatcher: { retryDelayMs: 0, maxDeliveryAttempts: 2 },
      ...extra,
    });
    open.push(scheduler);
    drivers.set(scheduler, driver);
    return { scheduler, driver, clock };
  }

  const drivers = new Map<Scheduler, FakeDriver>();
  const driverOf = (s: Scheduler) => drivers.get(s)!;

  async function readyDot(s: Scheduler, name: string, idle?: string) {
    const dot = await s.createDot(yaml(name, idle));
    await waitUntilSettledReady(s, driverOf(s), dot.id, name);
    return dot;
  }

  const types = (events: StoredEvent[]) => events.map((e) => e.type);

  it("create -> READY: pushes the key and the runtime config, records images and state events", async () => {
    const { scheduler, driver } = make();
    const dot = await scheduler.createDot(yaml("ready-one"));
    expect(dot.status).toBe("CREATING");
    await waitFor(async () => (await db.dots.get(dot.id))?.status === "READY", "READY");

    const guest = driver.guestOf(dot.id);
    expect(guest.openrouterKey).toBe("sk-or-test");
    expect(guest.config?.name).toBe("ready-one");
    expect(guest.config).not.toHaveProperty("computer");
    const computer = await scheduler.computer(dot.id);
    expect(computer).toMatchObject({ state: "RUNNING", ready: true, golden_image: driver.goldenImage, vm_name: `invisible-dot-${dot.id}` });
    expect(computer.guest_port).toBe(driver.vms.get(dot.id)?.guestPort);
    expect(computer.pid).toBe(driver.vms.get(dot.id)?.pid);
    const events = await db.events.list({ dotId: dot.id });
    expect(types(events)).toEqual(
      expect.arrayContaining(["dot.created", "computer.state", "computer.started"]),
    );
    expect(events.filter((e) => e.type === "computer.state").map((e) => e.data.state)).toEqual([
      "PROVISIONING",
      "STARTING",
      "RUNNING",
    ]);
  });

  it("task -> guest events -> COMPLETED, with the cursor advanced and the run delivered", async () => {
    const { scheduler } = make();
    const dot = await readyDot(scheduler, "task-one");
    const task = await scheduler.createTask(dot.id, { description: "check fares", priority: 2 });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "task COMPLETED");
    const done = await db.tasks.get(task.id);
    expect(done?.summary).toBe("done: check fares");
    expect(done?.started_at).not.toBeNull();
    const runs = await db.tasks.runs(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.delivered_at).not.toBeNull();
    expect(runs[0]?.outcome).toBe("completed");
    await waitFor(async () => (await db.computers.get(dot.id))?.event_cursor === 5, "every guest event stored");
    const guestEvents = (await db.events.list({ dotId: dot.id })).filter((e) => e.source === "guest");
    expect(types(guestEvents)).toEqual(["agent.started", "agent.state", "task.started", "task.completed", "agent.state"]);
    expect((await db.dots.get(dot.id))?.status).toBe("READY");
  });

  it("the spend a task's events report lands on the task: the highest heard, whatever ends it", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "spend-one");
    const guest = driver.guestOf(dot.id);
    guest.onInbound = () => {};
    const task = await scheduler.createTask(dot.id, { description: "costly" });
    await waitFor(async () => (await db.tasks.runs(task.id))[0]?.delivered_at, "delivered");
    const spent = async () => (await db.tasks.get(task.id))?.spent_usd;
    guest.emit("task.started", { task_id: task.id });
    guest.emit("task.progress", { task_id: task.id, text: "first step", spent_usd: 0.25 });
    await waitFor(async () => (await spent()) === 0.25, "progress spend");
    guest.emit("task.progress", { task_id: task.id, text: "second step", spent_usd: 0.75 });
    await waitFor(async () => (await spent()) === 0.75, "ticking spend");
    guest.emit("task.completed", { task_id: task.id, summary: "done", spent_usd: 0.875 });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "completed");
    expect(await spent()).toBe(0.875);
    expect((await db.tasks.get(task.id))?.summary).toBe("done");
  });

  it("a failed task keeps the spend its failure reports, and an event without one changes nothing", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "spend-two");
    const guest = driver.guestOf(dot.id);
    guest.onInbound = () => {};
    const task = await scheduler.createTask(dot.id, { description: "capped" });
    await waitFor(async () => (await db.tasks.runs(task.id))[0]?.delivered_at, "delivered");
    guest.emit("task.progress", { task_id: task.id, text: "x", spent_usd: 0.6 });
    guest.emit("task.progress", { task_id: task.id, text: "no spend reported" });
    guest.emit("task.failed", { task_id: task.id, error: "stopped: the task reached limits.max_cost_per_task_usd (spent 1.2000 USD of 1.00)", spent_usd: 1.2 });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "FAILED", "failed");
    expect((await db.tasks.get(task.id))?.spent_usd).toBe(1.2);
    expect((await scheduler.getTask(task.id)).spent_usd).toBe(1.2);
  });

  it("a cancelled task still takes the spend its guest reports afterwards", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "spend-three");
    const guest = driver.guestOf(dot.id);
    guest.onInbound = () => {};
    const task = await scheduler.createTask(dot.id, { description: "cancelled while spending" });
    await waitFor(async () => (await db.tasks.runs(task.id))[0]?.delivered_at, "delivered");
    guest.emit("task.progress", { task_id: task.id, text: "x", spent_usd: 0.25 });
    await waitFor(async () => (await db.tasks.get(task.id))?.spent_usd === 0.25, "first spend");
    await scheduler.cancelTask(task.id);
    guest.emit("task.failed", { task_id: task.id, error: "cancelled", spent_usd: 0.4 });
    await waitFor(async () => (await db.tasks.get(task.id))?.spent_usd === 0.4, "spend after the cancel");
    expect((await db.tasks.get(task.id))?.status).toBe("CANCELLED");
  });

  it("a guest cannot write the spend of another Dot's task", async () => {
    const { scheduler, driver } = make();
    const a = await readyDot(scheduler, "spend-owner");
    const b = await readyDot(scheduler, "spend-other");
    driver.guestOf(a.id).onInbound = () => {};
    const task = await scheduler.createTask(a.id, { description: "mine" });
    await waitFor(async () => (await db.tasks.runs(task.id))[0]?.delivered_at, "delivered");
    driver.guestOf(b.id).emit("task.progress", { task_id: task.id, text: "forged", spent_usd: 99 });
    await waitFor(async () => (await db.computers.get(b.id))?.event_cursor === 1, "forged event stored");
    expect((await db.tasks.get(task.id))?.spent_usd).toBe(0);
  });

  it("a reconnecting event stream does not store an event twice", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "replay-one");
    const guest = driver.guestOf(dot.id);
    const a = guest.emit("memory.written", { key: "a" });
    await waitFor(async () => (await db.computers.get(dot.id))?.event_cursor === a.seq, "first event");
    guest.disconnectStreams();
    const b = guest.emit("memory.written", { key: "b" });
    await waitFor(async () => (await db.computers.get(dot.id))?.event_cursor === b.seq, "second event after reconnect");
    const stored = (await db.events.list({ dotId: dot.id })).filter((e) => e.source === "guest");
    expect(stored.map((e) => e.guest_seq)).toEqual(guest.outbox.map((e) => e.seq));
  });

  it("a guest cannot complete another Dot's task", async () => {
    const { scheduler, driver } = make();
    const a = await readyDot(scheduler, "owner-a");
    const b = await readyDot(scheduler, "owner-b");
    driver.guestOf(a.id).onInbound = () => {};
    const task = await scheduler.createTask(a.id, { description: "slow" });
    await waitFor(async () => (await db.tasks.runs(task.id))[0]?.delivered_at, "delivered");
    driver.guestOf(b.id).emit("task.completed", { task_id: task.id, summary: "forged" });
    await waitFor(async () => (await db.computers.get(b.id))?.event_cursor === 1, "forged event stored");
    expect((await db.tasks.get(task.id))?.status).toBe("RUNNING");
  });

  it("approval flow: requested -> WAITING_APPROVAL -> approve -> guest resumes -> COMPLETED", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "approver");
    const guest = driver.guestOf(dot.id);
    const original = guest.onInbound;
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") {
        g.emit("task.started", { task_id: event.data.task_id });
        g.requestApproval(event.data.task_id);
      } else {
        return original(event, g);
      }
    };
    const task = await scheduler.createTask(dot.id, { description: "delete the old identity" });
    const approval = await waitFor(async () => (await scheduler.listApprovals("pending"))[0], "pending approval");
    expect(approval).toMatchObject({ dot_id: dot.id, task_id: task.id, tool: "browser_identity_delete" });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "WAITING_APPROVAL", "task waiting");
    await waitFor(async () => (await db.dots.get(dot.id))?.status === "WAITING_APPROVAL", "dot waiting");

    const resolved = await scheduler.resolveApproval(approval.id, "approve", { note: "go ahead" });
    expect(resolved.status).toBe("approved");
    const received = guest.inbound.find((e) => e.type === "approval.received");
    expect(received?.data).toEqual({ approval_id: approval.id, decision: "approve", note: "go ahead" });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "task completed");
    expect((await db.tasks.get(task.id))?.summary).toBe("approval approved");
    await expect(scheduler.resolveApproval(approval.id, "reject")).rejects.toMatchObject({
      status: 409,
      code: "already_resolved",
    });
    expect(types(await db.events.list({ dotId: dot.id, types: ["approval.resolved"] }))).toEqual(["approval.resolved"]);
  });

  it("approve with always: the permission becomes allow in the config and the guest, once, in the same transaction as the decision", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "always-allow");
    const guest = driver.guestOf(dot.id);
    expect(guest.config?.permissions["browser.identity.delete"]).toBe("ask");
    const original = guest.onInbound;
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") {
        g.emit("task.started", { task_id: event.data.task_id });
        g.requestApproval(event.data.task_id);
      } else {
        return original(event, g);
      }
    };
    const task = await scheduler.createTask(dot.id, { description: "delete the old identity" });
    const approval = await waitFor(async () => (await scheduler.listApprovals("pending")).find((a) => a.task_id === task.id), "pending approval");
    const configBefore = (await db.dots.get(dot.id))!.config;

    const resolved = await scheduler.resolveApproval(approval.id, "approve", { always: true, note: "fine" });
    expect(resolved.status).toBe("approved");
    const stored = (await db.dots.get(dot.id))!;
    expect(stored.config).toEqual({ ...configBefore, permissions: { ...configBefore.permissions, "browser.identity.delete": "allow" } });
    expect(guest.config?.permissions["browser.identity.delete"]).toBe("allow");
    expect(guest.config?.name).toBe("always-allow");
    const events = await db.events.list({ dotId: dot.id, types: ["approval.resolved", "dot.updated"] });
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ["approval.resolved", { approval_id: approval.id, decision: "approve", note: "fine", always: true }],
      ["dot.updated", { name: "always-allow", pushed_to_guest: true }],
    ]);
    // The guest is told the plain decision: what the config says is the guest's own business.
    expect(guest.inbound.find((e) => e.type === "approval.received")?.data).toEqual({ approval_id: approval.id, decision: "approve", note: "fine" });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "task completed");

    // Answered once: the second try is a 409 and changes nothing, however it asks.
    await db.dots.setPermission(dot.id, "browser.identity.delete", "ask");
    await expect(scheduler.resolveApproval(approval.id, "approve", { always: true })).rejects.toMatchObject({ status: 409, code: "already_resolved" });
    expect((await db.dots.get(dot.id))?.config.permissions["browser.identity.delete"]).toBe("ask");
    expect(types(await db.events.list({ dotId: dot.id, types: ["approval.resolved", "dot.updated"] }))).toEqual(["approval.resolved", "dot.updated"]);
  });

  it("approve with always: a flush that runs between the commit and the push does not send the answer ahead of the config", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "always-ordered");
    const guest = driver.guestOf(dot.id);
    const id = guest.requestApproval(undefined);
    await waitFor(async () => (await db.approvals.get(id)) !== null, "stored");
    let configWhenAnswered: string | undefined;
    const original = guest.onInbound;
    guest.onInbound = (event, g) => {
      if (event.type === "approval.received") configWhenAnswered = g.config?.permissions["browser.identity.delete"];
      return original(event, g);
    };
    let openGate!: () => void;
    guest.configPushGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const answered = scheduler.resolveApproval(id, "approve", { always: true });
    // The answer is committed and waits in the outbox, the push is in flight: every way a delivery can start is tried.
    await waitFor(async () => (await db.inbound.pending(dot.id)).some((row) => row.event.type === "approval.received"), "the answer stored");
    void scheduler.inbound.kick(dot.id);
    await scheduler.inbound.kickDue();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(guest.inbound.some((e) => e.type === "approval.received")).toBe(false);

    openGate();
    expect((await answered).status).toBe("approved");
    await scheduler.settle();
    expect(guest.inbound.some((e) => e.type === "approval.received")).toBe(true);
    expect(configWhenAnswered).toBe("allow");
    // The hold is gone: the next answer for this Dot is not held up.
    const next = guest.requestApproval(undefined);
    await waitFor(async () => (await db.approvals.get(next)) !== null, "stored");
    await scheduler.resolveApproval(next, "reject");
    await scheduler.settle();
    expect(guest.inbound.filter((e) => e.type === "approval.received")).toHaveLength(2);
  });

  it("approve with always refuses what cannot be allowed for good and leaves the approval pending", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "always-refused");
    const guest = driver.guestOf(dot.id);
    const known = guest.requestApproval(undefined);
    // The one way an approval of an unknown permission exists: a row stored before the permission was deleted from
    // PERMISSIONS (decision C1). The guest's own events cannot make one: the real client parses every event with the
    // permission list, so it is seeded through the repository, as the old row is.
    await waitFor(async () => (await db.approvals.get(known)) !== null, "stored");
    await db.approvals.insertRequested(dot.id, { approval_id: "apr_unknownpermission", tool: "mystery", permission: "made.up" as never, arguments: {}, reason: "?" });
    const configBefore = (await db.dots.get(dot.id))!.config;

    await expect(scheduler.resolveApproval(known, "reject", { always: true })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(scheduler.resolveApproval("apr_unknownpermission", "approve", { always: true })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(scheduler.resolveApproval(known, "approve", { always: false as unknown as true })).rejects.toMatchObject({ status: 400 });
    await expect(scheduler.resolveApproval("apr_missing", "approve", { always: true })).rejects.toMatchObject({ status: 404 });
    for (const id of [known, "apr_unknownpermission"]) expect((await db.approvals.get(id))?.status).toBe("pending");
    expect((await db.dots.get(dot.id))?.config).toEqual(configBefore);
    expect(await db.events.list({ dotId: dot.id, types: ["approval.resolved", "dot.updated"] })).toEqual([]);
    // A plain approval of the unknown permission still works: it asks nothing of the config.
    expect((await scheduler.resolveApproval("apr_unknownpermission", "approve")).status).toBe("approved");
  });

  it("approve with always on a sleeping Dot saves the config, and the wake that delivers the answer pushes it", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "always-asleep");
    const approvalId = driver.guestOf(dot.id).requestApproval(undefined);
    await waitFor(async () => (await db.approvals.get(approvalId)) !== null, "stored");
    await scheduler.stopComputer(dot.id);
    await scheduler.settle();
    expect((await db.computers.get(dot.id))?.state).toBe("STOPPED");

    await scheduler.resolveApproval(approvalId, "approve", { always: true });
    expect((await db.dots.get(dot.id))?.config.permissions["browser.identity.delete"]).toBe("allow");
    expect((await db.events.list({ dotId: dot.id, types: ["dot.updated"] })).at(-1)?.data).toEqual({ name: "always-asleep", pushed_to_guest: false });
    await waitFor(async () => (await db.computers.get(dot.id))?.state === "RUNNING", "woken for the answer");
    await waitFor(() => driver.guestOf(dot.id).config?.permissions["browser.identity.delete"] === "allow", "config pushed on the wake");
  });

  it("sleeps after idle_timeout (fake clock) and wakes on a new task", async () => {
    const { scheduler, driver, clock } = make();
    const dot = await readyDot(scheduler, "sleeper", "10m");
    expect(await scheduler.idleCheck()).toEqual([]);
    clock.advance(9 * 60_000);
    expect(await scheduler.idleCheck()).toEqual([]);
    clock.advance(2 * 60_000);
    expect(await scheduler.idleCheck()).toEqual([dot.id]);
    await scheduler.settle();
    expect((await db.computers.get(dot.id))?.state).toBe("STOPPED");
    expect((await db.dots.get(dot.id))?.status).toBe("IDLE");
    expect(driver.guestOf(dot.id).calls).toContain("prepareSleep");
    expect(driver.calls).toContain(`stop:${dot.id}`);
    const stopped = await db.events.list({ dotId: dot.id, types: ["computer.stopped"] });
    expect(stopped[0]?.data).toMatchObject({ reason: "idle" });

    const bootsBefore = driver.guestOf(dot.id).boots;
    const task = await scheduler.createTask(dot.id, { description: "after the nap" });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "task after wake");
    const guest = driver.guestOf(dot.id);
    expect(guest.boots).toBe(bootsBefore + 1);
    // The key lives in guest memory only and is pushed again on every READY.
    expect(guest.openrouterKey).toBe("sk-or-test");
    expect((await db.computers.get(dot.id))?.state).toBe("RUNNING");
  });

  it("does not sleep with idle_timeout 0, with a task in progress, or with a non-idle agent", async () => {
    const { scheduler, driver, clock } = make();
    const never = await readyDot(scheduler, "insomniac", "0");
    const busy = await readyDot(scheduler, "busy-bee", "1m");
    driver.guestOf(busy.id).onInbound = (event, g) => {
      if (event.type === "task.created") g.emit("agent.state", { state: "EXECUTING" });
    };
    const task = await scheduler.createTask(busy.id, { description: "long job" });
    await waitFor(async () => (await db.dots.get(busy.id))?.status === "RUNNING", "busy agent");
    clock.advance(24 * 3_600_000);
    expect(await scheduler.idleCheck()).toEqual([]);
    expect((await db.computers.get(never.id))?.state).toBe("RUNNING");
    expect((await db.tasks.get(task.id))?.status).toBe("RUNNING");
  });

  it("a message to a stopped Dot is queued, wakes it and is delivered", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "chatty");
    await scheduler.lifecycle.stop(dot.id, "user");
    const answer = await scheduler.sendMessage("chatty", "hello there");
    expect(answer.delivery).toBe("queued");
    await scheduler.settle();
    const guest = driver.guestOf(dot.id);
    expect(guest.inbound.at(-1)).toMatchObject({ id: answer.message_id, type: "user.message", data: { text: "hello there" } });
    await waitFor(async () => (await scheduler.conversation(dot.id)).length === 2, "assistant reply");
    const conversation = await scheduler.conversation(dot.id);
    expect(conversation.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello there"],
      ["assistant", "echo: hello there"],
    ]);
    const direct = await scheduler.sendMessage(dot.id, "again");
    expect(direct.delivery).toBe("delivered");
  });

  it("keeps where a message came from in the log and answers it in the conversation, never to the guest", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "bridged");
    const origin = { channel: "telegram", binding_id: "chb_1", chat_id: "4242", external_id: "77" } as const;
    const fromChannel = await scheduler.sendMessage(dot.id, "from my phone", origin);
    const fromApi = await scheduler.sendMessage(dot.id, "from the web");
    await waitFor(async () => (await scheduler.conversation(dot.id)).length === 4, "both replies");
    // The event log owns the fact.
    const logged = (await db.events.list({ dotId: dot.id, types: ["user.message"] })).map((e) => e.data);
    expect(logged).toEqual([
      { message_id: fromChannel.message_id, text: "from my phone", origin },
      { message_id: fromApi.message_id, text: "from the web" },
    ]);
    const conversation = await scheduler.conversation(dot.id);
    expect(conversation.filter((m) => m.role === "user").map((m) => m.origin)).toEqual([origin, undefined]);
    expect(conversation.some((m) => m.role === "assistant" && "origin" in m)).toBe(false);
    // The guest still gets {text}: nothing in the Dot knows about a channel.
    const received = driver.guestOf(dot.id).inbound.filter((e) => e.type === "user.message");
    expect(received.map((e) => e.data)).toEqual([{ text: "from my phone" }, { text: "from the web" }]);
  });

  it("hands a channel message to the Dot once however often it is offered, and answers a repeat with the first", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "repeated");
    const origin = { channel: "telegram", binding_id: "chb_1", chat_id: "4242", external_id: "77" } as const;
    const first = await scheduler.sendMessage(dot.id, "from my phone", origin);
    const again = await scheduler.sendMessage(dot.id, "from my phone", origin);
    expect(again).toEqual({ message_id: first.message_id, event_id: first.event_id, delivery: "delivered" });
    // The same id on another binding is another message.
    const other = await scheduler.sendMessage(dot.id, "from my phone", { ...origin, binding_id: "chb_2" });
    expect(other.message_id).not.toBe(first.message_id);
    await scheduler.settle();
    expect((await db.events.list({ dotId: dot.id, types: ["user.message"] })).map((e) => e.data.message_id)).toEqual([first.message_id, other.message_id]);
    expect(driver.guestOf(dot.id).inbound.filter((e) => e.type === "user.message").map((e) => e.id)).toEqual([first.message_id, other.message_id]);
    expect((await db.inbound.get(first.message_id))?.delivered_at).toBeTruthy();
  });

  it("refuses a message whose origin is not a channel chat, and logs nothing for it", async () => {
    const { scheduler } = make();
    const dot = await readyDot(scheduler, "strict");
    const before = (await db.events.list({ dotId: dot.id })).length;
    const bad = { channel: "sms", binding_id: "chb_1", chat_id: "1", external_id: "2" };
    await expect(scheduler.sendMessage(dot.id, "hi", bad as never)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(scheduler.sendMessage(dot.id, "hi", { ...bad, channel: "telegram", extra: 1 } as never)).rejects.toMatchObject({ status: 400 });
    expect((await db.events.list({ dotId: dot.id })).length).toBe(before);
  });

  it("leaves out an origin it cannot read in a stored message instead of failing the conversation", async () => {
    const { scheduler } = make();
    const dot = await readyDot(scheduler, "old-rows");
    await scheduler.events.appendUserMessage(dot.id, { message_id: "msg_old", text: "odd", origin: { channel: "sms" } as never });
    const [message] = await scheduler.conversation(dot.id);
    expect(message).toMatchObject({ role: "user", text: "odd" });
    expect("origin" in message!).toBe(false);
  });

  it("READY fails without an OpenRouter key and succeeds once one is set", async () => {
    await db.secrets.delete("global", "openrouter_api_key");
    try {
      const { scheduler } = make();
      const dot = await scheduler.createDot(yaml("keyless"));
      await waitFor(async () => (await db.dots.get(dot.id))?.status === "ERROR", "ERROR");
      expect((await db.dots.get(dot.id))?.error).toMatch(/no OpenRouter API key/);
      expect((await db.computers.get(dot.id))?.state).toBe("ERROR");
      await scheduler.setOpenRouterKey("sk-or-new", dot.id);
      await waitFor(async () => (await db.dots.get(dot.id))?.status === "READY", "READY after key");
    } finally {
      await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
    }
  });

  it("READY fails when a guest self-check fails, naming it", async () => {
    const driver = new FakeDriver();
    driver.configureGuest = (g) => {
      g.checks = { ...g.checks, browser_installed: false };
    };
    const { scheduler } = make(driver);
    const dot = await scheduler.createDot(yaml("no-browser"));
    await waitFor(async () => (await db.dots.get(dot.id))?.status === "ERROR", "ERROR");
    expect((await db.dots.get(dot.id))?.error).toMatch(/browser layer not installed/);
  });

  it("every start records a new guest port and pid; a stop clears them", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "port-mover");
    const before = await db.computers.get(dot.id);
    expect(before?.guest_port).toEqual(expect.any(Number));
    await scheduler.lifecycle.stop(dot.id, "user");
    expect(await db.computers.get(dot.id)).toMatchObject({ state: "STOPPED", guest_port: null, pid: null });
    await expect(scheduler.lifecycle.guest(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });

    await scheduler.lifecycle.ensureReady(dot.id);
    const after = await db.computers.get(dot.id);
    expect(after?.guest_port).not.toBe(before?.guest_port);
    expect(after?.pid).toBe(driver.vms.get(dot.id)?.pid);
    const started = await db.events.list({ dotId: dot.id, types: ["computer.started"] });
    expect(started.map((e) => e.data.guest_port)).toEqual([before?.guest_port, after?.guest_port]);
    // The old port reaches nothing any more: only the recorded one leads to the guest.
    const token = await db.computers.token(dot.id);
    await expect(driver.guest({ dotId: dot.id, port: before!.guest_port! }, token).health()).rejects.toMatchObject({ status: 0 });
  });

  it("a failed delivery is retried, then the task fails with the reason", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "flaky");
    const guest = driver.guestOf(dot.id);
    guest.failNextPost = new FakeGuestError(0, "connection reset");
    const ok = await scheduler.createTask(dot.id, { description: "eventually" });
    await waitFor(async () => (await db.tasks.get(ok.id))?.status === "COMPLETED", "retried task");
    // The same event went again: one run, never back to PENDING in between.
    expect((await db.tasks.runs(ok.id)).map((r) => r.outcome)).toEqual(["completed"]);

    driver.failNext("start", new Error("qemu-system-x86_64 exited: boom"), 2);
    await scheduler.lifecycle.stop(dot.id, "user");
    const doomed = await scheduler.createTask(dot.id, { description: "never" });
    await waitFor(async () => (await db.tasks.get(doomed.id))?.status === "FAILED", "failed task", 8_000);
    expect((await db.tasks.get(doomed.id))?.error).toMatch(/after 2 attempts/);
  });

  it("cancel: a pending task never runs, a finished one answers 409", async () => {
    const { scheduler } = make();
    const dot = await readyDot(scheduler, "canceller");
    const later = await scheduler.createTask(dot.id, {
      description: "tomorrow",
      scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const cancelled = await scheduler.cancelTask(later.id);
    expect(cancelled.status).toBe("CANCELLED");
    await expect(scheduler.cancelTask(later.id)).rejects.toMatchObject({ status: 409, code: "task_finished" });
    expect(types(await db.events.list({ dotId: dot.id, types: ["task.cancelled"] }))).toEqual(["task.cancelled"]);
  });

  it("identities need a running computer: 409 computer_stopped otherwise, guest 404 passes through", async () => {
    const { scheduler } = make();
    const dot = await readyDot(scheduler, "browser-owner");
    const created = await scheduler.createIdentity(dot.id, { name: "Shop Account" });
    expect(created.id).toMatch(/^shop-account-[a-z0-9]{6}$/);
    expect((await scheduler.listIdentities(dot.id)).map((i) => i.id)).toEqual([created.id]);
    await expect(scheduler.getIdentity(dot.id, "missing-abc123")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await scheduler.deleteIdentity(dot.id, created.id);
    await scheduler.lifecycle.stop(dot.id, "user");
    await expect(scheduler.listIdentities(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(scheduler.screenshot(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
  });

  it("PATCH pushes the new config to a READY guest and refuses a shrinking disk", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "patchy");
    const updated = await scheduler.updateDot("patchy", `${yaml("patchy")}instructions: be brief\n`);
    expect(updated.config.instructions).toBe("be brief");
    expect(driver.guestOf(dot.id).config?.instructions).toBe("be brief");
    await expect(
      scheduler.updateDot(dot.id, yaml("patchy").replace("computer:\n", "computer:\n  disk: 20gb\n")),
    ).rejects.toMatchObject({ status: 409, code: "disk_shrink" });
    await expect(scheduler.updateDot(dot.id, "name: Bad Name")).rejects.toMatchObject({ status: 400, code: "invalid_config" });
  });

  it("PATCH made from an old read is a 409 dot_changed: it cannot undo an always-allow answered since, and nothing is saved", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "stale-form");
    const guest = driver.guestOf(dot.id);
    const loaded = await scheduler.requireDot(dot.id);
    expect(loaded.config.permissions?.["browser.identity.delete"]).toBeUndefined();

    // Another view answers "Always allow" while the form is open.
    const approvalId = guest.requestApproval(undefined);
    await waitFor(async () => (await db.approvals.get(approvalId)) !== null, "stored");
    await scheduler.resolveApproval(approvalId, "approve", { always: true });
    expect((await db.dots.get(dot.id))?.config.permissions["browser.identity.delete"]).toBe("allow");

    const save = `${yaml("stale-form")}instructions: be brief\n`;
    await expect(scheduler.updateDot(dot.id, save, loaded.updated_at)).rejects.toMatchObject({ status: 409, code: "dot_changed" });
    const stored = (await db.dots.get(dot.id))!;
    expect(stored.config.permissions["browser.identity.delete"]).toBe("allow");
    expect(stored.config.instructions).toBeUndefined();
    expect(guest.config?.instructions).toBeUndefined();

    // Read again, the save goes through, once; a save with no precondition is as it always was; a malformed one is a 400.
    const fresh = await scheduler.requireDot(dot.id);
    expect((await scheduler.updateDot(dot.id, save, fresh.updated_at)).config.instructions).toBe("be brief");
    await expect(scheduler.updateDot(dot.id, save, fresh.updated_at)).rejects.toMatchObject({ status: 409, code: "dot_changed" });
    expect((await scheduler.updateDot(dot.id, `${yaml("stale-form")}instructions: no precondition\n`)).config.instructions).toBe("no precondition");
    await expect(scheduler.updateDot(dot.id, save, "yesterday")).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(scheduler.updateDot(dot.id, save, 5)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(scheduler.updateDot("missing-dot", save, fresh.updated_at)).rejects.toMatchObject({ status: 404 });
  });

  it("reboot waits for the new boot and pushes the key again", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "rebooter");
    const guest = driver.guestOf(dot.id);
    await scheduler.lifecycle.reboot(dot.id);
    expect(guest.boots).toBe(2);
    expect(guest.openrouterKey).toBe("sk-or-test");
    expect(scheduler.lifecycle.isReady(dot.id)).toBe(true);
  });

  it("recovery: a VM whose disk is gone is ERROR; a running VM's port and pid come from QEMU, not the row", async () => {
    const driver = new FakeDriver();
    const first = make(driver).scheduler;
    const lost = await readyDot(first, "disk-lost");
    const unrecorded = await readyDot(first, "port-lost");
    await first.close();
    open.splice(open.indexOf(first), 1);

    driver.vms.delete(lost.id);
    // As if the control plane stopped between spawning QEMU and recording its port.
    await db.computers.setProcess(unrecorded.id, null);

    const { scheduler } = make(driver, { dispatchIntervalMs: 60_000, idleCheckIntervalMs: 60_000 });
    await scheduler.start();
    await scheduler.settle();
    expect(await db.dots.get(lost.id)).toMatchObject({ status: "ERROR", error: "the VM disk is missing" });
    expect((await db.computers.get(lost.id))?.state).toBe("ERROR");
    expect(scheduler.lifecycle.isReady(unrecorded.id)).toBe(true);
    expect(await db.computers.get(unrecorded.id)).toMatchObject({
      guest_port: driver.vms.get(unrecorded.id)?.guestPort,
      pid: driver.vms.get(unrecorded.id)?.pid,
    });
    // Adopted, not restarted.
    expect(driver.guestOf(unrecorded.id).boots).toBe(1);
  });

  it("delete destroys the VM and removes the rows but keeps the history", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "goner");
    await scheduler.deleteDot("goner");
    await scheduler.settle();
    expect(driver.vms.has(dot.id)).toBe(false);
    expect(await db.dots.get(dot.id)).toBeNull();
    const history = await scheduler.listEvents(dot.id);
    expect(history.at(-1)?.type).toBe("dot.deleted");
    await expect(scheduler.requireDot("goner")).rejects.toMatchObject({ status: 404 });
  });

  it("events: filters by type and task, refuses a type no event has, and filters a deleted Dot's history by id", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "filtered");
    const task = await scheduler.createTask(dot.id, { description: "look" });
    await waitFor(async () => (await db.tasks.get(task.id))?.status === "COMPLETED", "task COMPLETED");
    await scheduler.sendMessage(dot.id, "hello");
    driver.guestOf(dot.id).emit("memory.written", { key: "a.md" });
    await waitFor(async () => (await scheduler.listEvents(dot.id, { types: ["memory.written"] })).length === 1, "note stored");

    expect(types(await scheduler.listEvents(dot.id, { types: ["user.message", "memory.written"] }))).toEqual(["user.message", "memory.written"]);
    expect(types(await scheduler.listEvents(dot.id, { taskId: task.id }))).toEqual(
      expect.arrayContaining(["task.created", "task.started", "task.completed"]),
    );
    expect((await scheduler.listEvents(dot.id, { taskId: task.id, types: ["task.completed"] })).map((e) => e.data.task_id)).toEqual([task.id]);
    // An empty list is no filter; a name that is no event type is an error rather than a quiet Dot.
    expect((await scheduler.listEvents(dot.id, { types: [] })).length).toBeGreaterThan(5);
    await expect(scheduler.listEvents(dot.id, { types: ["task.completed", "task.done"] })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(scheduler.listEvents(dot.id, { taskId: "" })).rejects.toMatchObject({ status: 400 });

    await scheduler.deleteDot("filtered");
    await scheduler.settle();
    expect(types(await scheduler.listEvents(dot.id, { taskId: task.id, types: ["task.completed"] }))).toEqual(["task.completed"]);
  });

  it("files: the path rule comes before the guest, the guest's refusals pass through, and a stopped computer is 409", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "filer");
    const guest = driver.guestOf(dot.id);
    guest.putFile("/home/dot/memory/a.md", "alpha");
    const calls = guest.calls.length;

    expect(await scheduler.listFiles(dot.id)).toMatchObject({ path: "/home/dot", entries: [{ name: "memory", type: "dir" }] });
    expect(await scheduler.listFiles("filer", "memory")).toMatchObject({ path: "/home/dot/memory", entries: [{ name: "a.md", size: 5 }] });
    const read = await scheduler.readFile(dot.id, "~/memory/a.md");
    expect(read.path).toBe("/home/dot/memory/a.md");
    expect(new TextDecoder().decode(read.content)).toBe("alpha");
    expect(guest.calls.slice(calls)).toEqual(["listFiles", "listFiles", "readFile"]);

    const before = guest.calls.length;
    await expect(scheduler.readFile(dot.id, "/etc/passwd")).rejects.toMatchObject({ status: 400, code: "invalid_path" });
    await expect(scheduler.listFiles(dot.id, "memory/../..")).rejects.toMatchObject({ status: 400, code: "invalid_path" });
    await expect(scheduler.readFile(dot.id, undefined)).rejects.toMatchObject({ status: 400, code: "invalid_path" });
    expect(guest.calls.length).toBe(before);

    await expect(scheduler.readFile(dot.id, "memory/none.md")).rejects.toMatchObject({ status: 404, code: "not_found" });
    guest.putFile("/home/dot/big", new Uint8Array(16 * 1024 * 1024 + 1));
    await expect(scheduler.readFile(dot.id, "big")).rejects.toMatchObject({ status: 413, code: "file_too_large" });
    // A guest that cannot be reached is the Dot's computer not answering, not the caller's fault.
    guest.powerOff();
    await expect(scheduler.readFile(dot.id, "memory/a.md")).rejects.toMatchObject({ status: 502, code: "guest_unavailable" });
  });

  it("files: a symbolic link under home that leads out of it is the guest's 403 outside_home, and one that stays is read", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "linker");
    const guest = driver.guestOf(dot.id);
    guest.putFile("/home/dot/documents/note.txt", "kept");
    guest.putFile("/etc/invisible-dots/config.json", "token");
    // The lexical rule lets all of these through (they name a path under home); the guest's real-path rule is what refuses.
    guest.link("/home/dot/environ", "/proc/4242/environ");
    guest.link("/home/dot/config", "/etc/invisible-dots/config.json");
    guest.link("/home/dot/etc", "/etc");
    guest.link("/home/dot/docs", "/home/dot/documents");

    for (const path of ["environ", "config", "etc/invisible-dots/config.json", "/home/dot/environ"]) {
      await expect(scheduler.readFile(dot.id, path), path).rejects.toMatchObject({ status: 403, code: "outside_home" });
    }
    await expect(scheduler.listFiles(dot.id, "etc")).rejects.toMatchObject({ status: 403, code: "outside_home" });
    expect(new TextDecoder().decode((await scheduler.readFile(dot.id, "docs/note.txt")).content)).toBe("kept");
    expect(await scheduler.listFiles(dot.id, "docs")).toMatchObject({ entries: [{ name: "note.txt", size: 4 }] });
  });

  it("automations: listed, paused and resumed, removed, with the guest's refusals passed through and a bad flag refused first", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "automator");
    const guest = driver.guestOf(dot.id);
    guest.putAutomation(automation());
    guest.putAutomation(automation({ id: "job_2", name: "weekly", enabled: false, next_run_at_ms: null }));

    expect((await scheduler.listAutomations("automator")).map((a) => [a.id, a.enabled])).toEqual([["job_1", true], ["job_2", false]]);
    expect(await scheduler.setAutomationEnabled(dot.id, "job_1", false)).toMatchObject({ id: "job_1", enabled: false, next_run_at_ms: null });
    expect(await scheduler.setAutomationEnabled(dot.id, "job_1", true)).toMatchObject({ enabled: true });
    await scheduler.deleteAutomation(dot.id, "job_2");
    expect((await scheduler.listAutomations(dot.id)).map((a) => a.id)).toEqual(["job_1"]);

    // A flag that is not a boolean never reaches the guest; what the guest refuses passes through.
    const calls = guest.calls.length;
    for (const bad of [undefined, null, "true", 1]) {
      await expect(scheduler.setAutomationEnabled(dot.id, "job_1", bad)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    expect(guest.calls.length).toBe(calls);
    await expect(scheduler.deleteAutomation(dot.id, "job_2")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(scheduler.setAutomationEnabled(dot.id, "nope", true)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("tools: the engine's table with what is offered now; an unreachable computer is not an empty table", async () => {
    const { scheduler, driver } = make();
    const dot = await readyDot(scheduler, "toolbox");
    const guest = driver.guestOf(dot.id);

    const tools = await scheduler.listTools("toolbox");
    expect(tools.map((t) => [t.name, t.permission])).toEqual([
      ["exec", "computer.exec"],
      ["read_file", "files.read"],
      ["write_file", "files.write"],
      ["memory_search", "memory.read"],
      ["memory_get", "memory.read"],
      ["cron", "automations"],
    ]);
    // The config the host pushed has its defaults filled in: nothing is denied, so the model is offered every tool.
    expect(tools.every((t) => t.offered)).toBe(true);
    await scheduler.updateDot(dot.id, `${yaml("toolbox")}permissions:
  automations: deny
`);
    await waitFor(async () => (await scheduler.listTools(dot.id)).some((t) => !t.offered), "config pushed");
    expect((await scheduler.listTools(dot.id)).filter((t) => !t.offered).map((t) => t.name)).toEqual(["cron"]);

    guest.powerOff();
    await expect(scheduler.listTools(dot.id)).rejects.toMatchObject({ status: 502, code: "guest_unavailable" });
    await expect(scheduler.listAutomations(dot.id)).rejects.toMatchObject({ status: 502, code: "guest_unavailable" });
  });

  it("automations and tools need a running computer", async () => {
    const { scheduler } = make();
    const dot = await readyDot(scheduler, "tool-sleeper");
    await scheduler.stopComputer(dot.id);
    await scheduler.settle();

    await expect(scheduler.listAutomations(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(scheduler.setAutomationEnabled(dot.id, "job_1", true)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(scheduler.deleteAutomation(dot.id, "job_1")).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(scheduler.listTools(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
  });

  it("delete removes the Dot's own OpenRouter key and keeps the global one", async () => {
    const { scheduler } = make();
    const dot = await readyDot(scheduler, "keyed");
    await scheduler.setOpenRouterKey("sk-or-own", dot.id);
    expect(await db.secrets.get(dot.id, "openrouter_api_key")).toBe("sk-or-own");
    await scheduler.deleteDot("keyed");
    await scheduler.settle();
    expect(await db.secrets.get(dot.id, "openrouter_api_key")).toBeNull();
    expect(await db.secrets.get("global", "openrouter_api_key")).toBe("sk-or-test");
  });

  it("recovery: reattaches to running VMs, marks powered-off ones STOPPED and delivers undelivered tasks", async () => {
    const driver = new FakeDriver();
    const first = make(driver).scheduler;
    const alive = await readyDot(first, "survivor");
    const dead = await readyDot(first, "casualty");
    await first.close();
    open.splice(open.indexOf(first), 1);

    // While the control plane was down: one VM powered off, one task claimed but never delivered.
    driver.crash(dead.id);
    const orphan = await db.tasks.insert({ id: `task_orphan${Date.now()}`, dotId: alive.id, description: "orphan" });
    await db.transaction((tx) => tx.tasks.claimNext());
    driver.guestOf(alive.id).emit("memory.written", { key: "while-away" });

    const { scheduler } = make(driver, { dispatchIntervalMs: 60_000, idleCheckIntervalMs: 60_000 });
    await scheduler.start();
    await waitFor(async () => (await db.tasks.get(orphan.id))?.status === "COMPLETED", "orphan task completed");
    // Reattached through the recorded port: no second QEMU was spawned for the survivor.
    expect(driver.calls.filter((c) => c === `start:${alive.id}`)).toHaveLength(1);
    expect(scheduler.lifecycle.isReady(alive.id)).toBe(true);
    expect(await db.computers.get(dead.id)).toMatchObject({ state: "STOPPED", guest_port: null, pid: null });
    expect((await db.dots.get(dead.id))?.status).toBe("IDLE");
    // Claimed before the restart, sent after it from the outbox: one run, one task.created.
    const runs = await db.tasks.runs(orphan.id);
    expect(runs.map((r) => r.outcome)).toEqual(["completed"]);
    expect(driver.guestOf(alive.id).inbound.filter((e) => e.type === "task.created" && e.data.task_id === orphan.id)).toHaveLength(1);
    const memory = await db.events.list({ dotId: alive.id, types: ["memory.written"] });
    expect(memory.map((e) => e.data.key)).toEqual(["while-away"]);
  });
});
