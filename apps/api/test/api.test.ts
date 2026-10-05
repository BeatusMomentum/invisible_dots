import type { AddressInfo } from "node:net";
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { Scheduler } from "@invisible-dots/scheduler";
import { FakeDriver, ManualClock, waitFor, waitUntilSettledReady } from "@invisible-dots/scheduler/testing";
import { ApiError, InvisibleDotsClient } from "@invisible-dots/sdk";
import { OPENROUTER_KEY_RULE, type StoredEvent } from "@invisible-dots/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type FastifyInstance } from "../src/index.js";

const TOKEN = "test-token-0123456789abcdef";

const yaml = (name: string, idle = "15m") =>
  `name: ${name}\ngoal: watch fares\nmodel:\n  provider: openrouter\n  id: test/model\ncomputer:\n  idle_timeout: ${idle}\n`;

describe.each(testAdapters())("control-plane API (%s)", (kind) => {
  let t: TestDatabase;
  let db: Database;
  let app: FastifyInstance;
  let scheduler: Scheduler;
  let driver: FakeDriver;
  let clock: ManualClock;
  let base: string;
  let api: InvisibleDotsClient;

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    driver = new FakeDriver();
    clock = new ManualClock();
    scheduler = new Scheduler({
      db,
      driver,
      clock,
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10 },
      dispatcher: { retryDelayMs: 0 },
    });
    app = buildServer({ scheduler, token: TOKEN, heartbeatMs: 50 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    api = new InvisibleDotsClient({ baseUrl: base, token: TOKEN });
  });

  afterAll(async () => {
    await app?.close();
    await scheduler?.close();
    await t?.drop();
  });

  async function readyDot(name: string, idle?: string) {
    const dot = await api.createDot(yaml(name, idle));
    await waitUntilSettledReady(scheduler, driver, dot.id, name);
    return dot;
  }

  it("refuses requests without the right bearer token with 401 JSON", async () => {
    const none = await fetch(`${base}/api/dots`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: "unauthorized" });
    const wrong = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    const stream = await fetch(`${base}/api/stream`, { headers: { authorization: "Basic abc" } });
    expect(stream.status).toBe(401);
    await expect(new InvisibleDotsClient({ baseUrl: base, token: "wrong-token-xxxxxxxx" }).health()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("health, unknown routes and malformed bodies answer {error, message}", async () => {
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
    expect(await api.health()).toMatchObject({ status: "ok", database: "ok" });
    const missing = await fetch(`${base}/api/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
    const broken = await fetch(`${base}/api/dots`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: "invalid_request" });
  });

  it("create validates the config: 400 with the issues, 409 for a taken name", async () => {
    const invalid = await api.createDot({ name: "Bad Name", goal: "x", model: { provider: "openrouter", id: "m" } }).catch((e) => e);
    expect(invalid).toBeInstanceOf(ApiError);
    expect(invalid).toMatchObject({ status: 400, code: "invalid_config" });
    expect((invalid as ApiError).details).toEqual([expect.objectContaining({ path: "name" })]);
    await readyDot("taken-name");
    await expect(api.createDot(yaml("taken-name"))).rejects.toMatchObject({ status: 409, code: "name_taken" });
  });

  it("create -> READY -> task -> guest events -> COMPLETED, visible in tasks, events and the stream", async () => {
    const controller = new AbortController();
    const seen: StoredEvent[] = [];
    const streaming = (async () => {
      for await (const event of api.stream({ signal: controller.signal })) {
        seen.push(event);
        if (event.type === "task.completed") break;
      }
    })();

    const dot = await readyDot("flow-dot");
    expect((await api.listDots()).map((d) => d.name)).toContain("flow-dot");
    expect(await api.getDot("flow-dot")).toMatchObject({ id: dot.id, computer_state: "RUNNING" });
    const computer = await api.computer(dot.id);
    expect(computer).toMatchObject({ state: "RUNNING", ready: true });

    const task = await api.createTask("flow-dot", { description: "find the cheapest day", priority: 1 });
    expect(task.status).toBe("PENDING");
    await waitFor(async () => (await api.getTask(task.id)).status === "COMPLETED", "task COMPLETED");
    expect((await api.listTasks(dot.id)).map((x) => x.id)).toContain(task.id);
    await streaming;
    controller.abort();
    expect(seen.map((e) => e.type)).toEqual(expect.arrayContaining(["dot.created", "computer.started", "task.created", "task.completed"]));

    const events = await api.events(dot.id);
    expect(events.find((e) => e.type === "task.completed")?.data).toMatchObject({ task_id: task.id });
    const after = events[1]!.id;
    expect((await api.events(dot.id, { after, limit: 2 })).map((e) => e.id)).toEqual(events.slice(2, 4).map((e) => e.id));
    await expect(api.events(dot.id, { limit: 5000 })).rejects.toMatchObject({ status: 400 });
    await expect(api.cancelTask(task.id)).rejects.toMatchObject({ status: 409, code: "task_finished" });
  });

  it("the stream filters by Dot and replays after an id without duplicates", async () => {
    const a = await readyDot("stream-a");
    const b = await readyDot("stream-b");
    const history = await api.events(a.id);
    const controller = new AbortController();
    const got: StoredEvent[] = [];
    const reading = (async () => {
      for await (const event of api.stream({ dotId: "stream-a", after: history[0]!.id, signal: controller.signal })) {
        got.push(event);
        if (event.type === "memory.written") break;
      }
    })();
    driver.guestOf(b.id).emit("memory.written", { key: "b-only" });
    driver.guestOf(a.id).emit("memory.written", { key: "a-only" });
    await reading;
    controller.abort();
    expect(got.every((e) => e.dot_id === a.id)).toBe(true);
    expect(got.map((e) => e.id)).toEqual([...new Set(got.map((e) => e.id))]);
    expect(got[0]?.id).toBe(history[1]?.id);
    expect(got.at(-1)?.data).toMatchObject({ key: "a-only" });
  });

  it("approval flow over HTTP", async () => {
    const dot = await readyDot("asks-first");
    const guest = driver.guestOf(dot.id);
    const original = guest.onInbound;
    guest.onInbound = (event, g) => {
      if (event.type === "task.created") g.requestApproval(event.data.task_id);
      else return original(event, g);
    };
    const task = await api.createTask(dot.id, { description: "delete an identity" });
    const pending = await waitFor(
      async () => (await api.listApprovals("pending")).find((a) => a.dot_id === dot.id),
      "approval pending",
    );
    expect(pending.task_id).toBe(task.id);
    await waitFor(async () => (await api.getTask(task.id)).status === "WAITING_APPROVAL", "task waiting");
    const rejected = await api.reject(pending.id, "keep it");
    expect(rejected).toMatchObject({ status: "rejected", note: "keep it" });
    await waitFor(async () => (await api.getTask(task.id)).status === "COMPLETED", "task resumed and completed");
    await expect(api.approve(pending.id)).rejects.toMatchObject({ status: 409, code: "already_resolved" });
    await expect(api.approve("apr_missing")).rejects.toMatchObject({ status: 404 });
    const raw = await fetch(`${base}/api/approvals?status=maybe`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(raw.status).toBe(400);
  });

  it("messages: delivered to a READY Dot and readable as a conversation", async () => {
    const dot = await readyDot("talker");
    const sent = await api.sendMessage("talker", "what did you find?");
    expect(sent.delivery).toBe("delivered");
    await waitFor(async () => (await api.messages(dot.id)).length === 2, "reply");
    expect((await api.messages(dot.id)).map((m) => m.role)).toEqual(["user", "assistant"]);
    await expect(api.sendMessage(dot.id, "  ")).rejects.toMatchObject({ status: 400 });
  });

  it("browser identities and screenshots need a running computer (409 computer_stopped)", async () => {
    const dot = await readyDot("browsing");
    const identity = await api.createIdentity(dot.id, { name: "Main account" });
    expect(identity.name).toBe("Main account");
    expect((await api.listIdentities(dot.id)).map((i) => i.id)).toEqual([identity.id]);
    expect((await api.getIdentity(dot.id, identity.id)).id).toBe(identity.id);
    await expect(api.getIdentity(dot.id, "nobody-abc123")).rejects.toMatchObject({ status: 404, code: "not_found" });
    const png = await api.screenshot(dot.id);
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await api.deleteIdentity(dot.id, identity.id);

    expect(await api.stopComputer(dot.id)).toEqual({ accepted: true });
    await scheduler.settle();
    expect((await api.computer(dot.id)).state).toBe("STOPPED");
    expect((await api.getDot(dot.id)).status).toBe("IDLE");
    await expect(api.listIdentities(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(api.createIdentity(dot.id, { name: "x" })).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(api.screenshot(dot.id)).rejects.toMatchObject({ status: 409, code: "computer_stopped" });

    await api.startComputer(dot.id);
    await waitFor(async () => (await api.computer(dot.id)).ready, "started again");
  });

  it("sleeps after idle_timeout (fake clock) and a new task wakes it", async () => {
    const dot = await readyDot("napper", "5m");
    clock.advance(6 * 60_000);
    expect(await scheduler.idleCheck()).toContain(dot.id);
    await scheduler.settle();
    expect((await api.computer(dot.id)).state).toBe("STOPPED");
    const task = await api.createTask(dot.id, { description: "wake up" });
    await waitFor(async () => (await api.getTask(task.id)).status === "COMPLETED", "task after wake");
    expect((await api.computer(dot.id)).state).toBe("RUNNING");
  });

  it("the secret route refuses a key that cannot travel in a header with 400, naming the rule and never the key", async () => {
    const dot = await readyDot("key-check");
    expect(await api.setOpenRouterKey("sk-or-good", dot.id)).toEqual({ pushed: 1 });

    for (const bad of ["sk-or-v1-SECRETHEAD\nSECRETTAIL", "sk-or-v1-SECRET HEAD", "sk-or-v1-SECRETüHEAD", "SECRET\u0000HEAD"]) {
      const refused = await api.setOpenRouterKey(bad, dot.id).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ApiError);
      expect(refused).toMatchObject({ status: 400, code: "invalid_request" });
      expect((refused as ApiError).message).toContain(OPENROUTER_KEY_RULE);
      expect((refused as ApiError).message).not.toContain("SECRET");
    }
    // Nothing was stored or pushed by the refusals.
    expect(await db.secrets.get(dot.id, "openrouter_api_key")).toBe("sk-or-good");
    expect(driver.guestOf(dot.id).openrouterKey).toBe("sk-or-good");

    // A pasted key with its ends trimmed is the key.
    await api.setOpenRouterKey("  sk-or-padded\n", dot.id);
    expect(driver.guestOf(dot.id).openrouterKey).toBe("sk-or-padded");
  });

  it("PATCH updates the config; DELETE removes the Dot; the secret route stores the key", async () => {
    const dot = await readyDot("to-patch");
    const updated = await api.updateDot(dot.id, `${yaml("to-patch")}instructions: short answers\n`);
    expect(updated.config.instructions).toBe("short answers");
    expect(driver.guestOf(dot.id).config?.instructions).toBe("short answers");

    expect(await api.setOpenRouterKey("sk-or-rotated", "to-patch")).toEqual({ pushed: 1 });
    expect(driver.guestOf(dot.id).openrouterKey).toBe("sk-or-rotated");
    await expect(api.setOpenRouterKey("")).rejects.toMatchObject({ status: 400 });

    expect(await api.deleteDot("to-patch")).toEqual({ accepted: true });
    await scheduler.settle();
    await expect(api.getDot("to-patch")).rejects.toMatchObject({ status: 404 });
    expect((await api.events(dot.id)).at(-1)?.type).toBe("dot.deleted");
  });
});
