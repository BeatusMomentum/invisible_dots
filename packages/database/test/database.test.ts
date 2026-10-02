import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, parseDotConfig, type OutboundEvent } from "@invisible-dots/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Database,
  DotNameTakenError,
  loadMasterKey,
  loadMigrations,
  migrate,
  SecretBox,
  type Repositories,
} from "../src/index.js";
import { createTestDatabase, TEST_DATABASE_URL, warnIfNoDatabase, type TestDatabase } from "../src/testing.js";

const skip = warnIfNoDatabase("packages/database");

describe("SecretBox", () => {
  it("round-trips and binds a value to its associated data", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.encrypt("sk-or-test", "secret:global:openrouter_api_key");
    expect(sealed.includes(Buffer.from("sk-or-test"))).toBe(false);
    expect(box.decrypt(sealed, "secret:global:openrouter_api_key")).toBe("sk-or-test");
    expect(() => box.decrypt(sealed, "secret:dot_x:openrouter_api_key")).toThrow(/cannot decrypt/);
  });

  it("refuses a key of the wrong size and a different key", () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow(/32 bytes/);
    const sealed = new SecretBox(randomBytes(32)).encrypt("v", "a");
    expect(() => new SecretBox(randomBytes(32)).decrypt(sealed, "a")).toThrow(/wrong master key/);
  });
});

describe("loadMasterKey", () => {
  it("prefers the hex environment variable", async () => {
    const hex = randomBytes(32).toString("hex");
    expect((await loadMasterKey({ INVISIBLE_DOTS_MASTER_KEY: hex })).toString("hex")).toBe(hex);
    await expect(loadMasterKey({ INVISIBLE_DOTS_MASTER_KEY: "abc" })).rejects.toThrow(/64 hexadecimal/);
  });

  it("reads 32 raw bytes or 64 hex characters from master.key in the config dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "idots-key-"));
    try {
      const raw = randomBytes(32);
      await writeFile(join(dir, "master.key"), raw);
      expect((await loadMasterKey({ INVISIBLE_DOTS_CONFIG_DIR: dir })).equals(raw)).toBe(true);
      await writeFile(join(dir, "master.key"), `${raw.toString("hex")}\n`);
      expect((await loadMasterKey({ INVISIBLE_DOTS_CONFIG_DIR: dir })).equals(raw)).toBe(true);
      await rm(join(dir, "master.key"));
      await expect(loadMasterKey({ INVISIBLE_DOTS_CONFIG_DIR: dir })).rejects.toThrow(/cannot read the master key/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadMigrations", () => {
  it("finds the shipped migrations in order", async () => {
    const files = await loadMigrations();
    expect(files[0]?.version).toBe("0001_initial");
    expect(files[0]?.sql).toContain("CREATE TABLE dots");
  });
});

const yaml = (name: string) => `name: ${name}\ngoal: test goal\nmodel:\n  provider: openrouter\n  id: test/model\n`;

async function seedDot(r: Repositories, name: string, cid: number) {
  const id = newId("dot");
  const dot = await r.dots.insert({ id, config: parseDotConfig(yaml(name)), status: "READY" });
  await r.computers.insert({ dotId: id, domainName: `invisible-dot-${id}`, cid, state: "RUNNING", token: `tok-${name}` });
  return dot;
}

function outbound(seq: number, type: OutboundEvent["type"], data: Record<string, unknown>): OutboundEvent {
  return { seq, id: `evt-${seq}`, type, ts: new Date().toISOString(), data } as OutboundEvent;
}

// CREATE DATABASE and DROP DATABASE force checkpoints, which take seconds on a
// busy or virtualized disk while other test files create theirs in parallel.
describe.skipIf(skip)("PostgreSQL repositories", { timeout: 30_000 }, () => {
  let t: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("migrate is idempotent and records each version", async () => {
    const again = await db.migrate();
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toContain("0001_initial");
    const { rows } = await db.pool.query("SELECT version FROM schema_migrations");
    expect(rows.map((r) => r.version)).toEqual(["0001_initial"]);
  });

  it("two concurrent migrate runs on a fresh database apply each file once", async () => {
    const name = `idots_mig_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    const pools = [new pg.Pool({ connectionString: url.toString() }), new pg.Pool({ connectionString: url.toString() })];
    try {
      const results = await Promise.all(pools.map((p) => migrate(p)));
      expect(results.flatMap((r) => r.applied)).toEqual(["0001_initial"]);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("a failing migration is rolled back and named in the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "idots-mig-"));
    try {
      await writeFile(join(dir, "0001_initial.sql"), "SELECT 1;");
      await writeFile(join(dir, "9999_broken.sql"), "CREATE TABLE zz_partial (a int); SELECT nope FROM nowhere;");
      await expect(db.migrate({ dir })).rejects.toThrow(/migration 9999_broken failed/);
      const { rows } = await db.pool.query("SELECT to_regclass('zz_partial') AS t");
      expect(rows[0].t).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dots: unique names, resolve by id or name, status with error", async () => {
    const dot = await seedDot(db, "alpha", 20001);
    await expect(
      db.dots.insert({ id: newId("dot"), config: parseDotConfig(yaml("alpha")), status: "CREATING" }),
    ).rejects.toBeInstanceOf(DotNameTakenError);
    expect((await db.dots.resolve("alpha"))?.id).toBe(dot.id);
    expect((await db.dots.resolve(dot.id))?.computer_state).toBe("RUNNING");
    const errored = await db.dots.setStatus(dot.id, "ERROR", "boom");
    expect(errored?.error).toBe("boom");
    expect((await db.dots.setStatus(dot.id, "READY"))?.error).toBeNull();
    expect((await db.dots.list()).map((d) => d.name)).toContain("alpha");
  });

  it("computers: token is stored encrypted and decrypts, CIDs skip taken and excluded values", async () => {
    const dot = await seedDot(db, "bravo", 20002);
    const { rows } = await db.pool.query("SELECT token_enc FROM computers WHERE dot_id = $1", [dot.id]);
    expect(Buffer.from(rows[0].token_enc).includes(Buffer.from("tok-bravo"))).toBe(false);
    expect(await db.computers.token(dot.id)).toBe("tok-bravo");
    expect(await db.computers.nextFreeCid(20001)).toBe(20003);
    expect(await db.computers.nextFreeCid(20001, [20003, 20004])).toBe(20005);
    expect(await db.computers.nextFreeCid(0)).toBeGreaterThanOrEqual(3);

    await db.computers.advanceCursor(dot.id, 7, new Date("2030-01-01T00:00:00Z"));
    await db.computers.advanceCursor(dot.id, 3, new Date("2030-01-01T00:00:01Z"));
    const computer = await db.computers.get(dot.id);
    expect(computer?.event_cursor).toBe(7);
    expect(computer?.last_active_at).toBe("2030-01-01T00:00:01.000Z");
    expect((await db.computers.setState(dot.id, "ERROR", "virsh failed"))?.last_error).toBe("virsh failed");
    expect((await db.computers.setState(dot.id, "STOPPED"))?.last_error).toBe("virsh failed");
    expect((await db.computers.setState(dot.id, "RUNNING", null))?.last_error).toBeNull();
  });

  it("events: guest events are idempotent on (dot_id, guest_seq) and queries filter", async () => {
    const dot = await seedDot(db, "charlie", 20010);
    const first = await db.events.insertGuest(dot.id, outbound(1, "agent.state", { state: "THINKING" }));
    expect(first?.guest_seq).toBe(1);
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

  it("tasks: claim skips busy Dots, honours priority and scheduled_at, and SKIP LOCKED never hands one Dot two tasks", async () => {
    const a = await seedDot(db, "delta", 20020);
    const b = await seedDot(db, "echo", 20021);
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

    // Dot a is busy and Dot b's task is not due.
    expect(await db.transaction((tx) => tx.tasks.claimNext())).toBeNull();
    expect(await db.tasks.hasWork(b.id, new Date())).toBe(false);
    expect(await db.tasks.hasWork(a.id, new Date())).toBe(true);

    // Delivery failed: back in the queue, recorded as a failed delivery.
    await db.tasks.requeue(high.id, claimed[0]!.run.id, "undelivered", null);
    expect(await db.tasks.failedDeliveries(high.id)).toBe(1);
    const again = await db.transaction((tx) => tx.tasks.claimNext());
    expect(again?.task.id).toBe(high.id);
    expect(await db.tasks.interruptedRuns()).toHaveLength(1);
    await db.tasks.markDelivered(again!.run.id);
    expect(await db.tasks.interruptedRuns()).toHaveLength(0);

    const done = await db.tasks.transition(high.id, "COMPLETED", { summary: "ok" });
    expect(done?.status).toBe("COMPLETED");
    expect(done?.finished_at).not.toBeNull();
    expect((await db.tasks.runs(high.id)).at(-1)?.outcome).toBe("completed");
    // Terminal tasks do not move again.
    expect(await db.tasks.transition(high.id, "FAILED", { error: "late" })).toBeNull();

    const next = await db.transaction((tx) => tx.tasks.claimNext());
    expect(next?.task.id).toBe(low.id);
    expect((await db.tasks.listByDot(a.id)).map((t) => t.id)).toContain(low.id);
  });

  it("approvals: replayed requests are ignored and a resolution happens once", async () => {
    const dot = await seedDot(db, "foxtrot", 20030);
    const data = {
      approval_id: newId("apr"),
      tool: "browser_identity_delete",
      permission: "browser.identity.delete" as const,
      arguments: { identity_id: "x-abc123" },
      reason: "cleanup",
    };
    expect((await db.approvals.insertRequested(dot.id, data))?.status).toBe("pending");
    expect(await db.approvals.insertRequested(dot.id, data)).toBeNull();
    expect((await db.approvals.list({ status: "pending", dotId: dot.id })).map((a) => a.id)).toEqual([data.approval_id]);
    expect((await db.approvals.resolve(data.approval_id, "approved", "fine"))?.note).toBe("fine");
    expect(await db.approvals.resolve(data.approval_id, "rejected", null)).toBeNull();
  });

  it("secrets: encrypted at rest, per-Dot key wins over the global one", async () => {
    const dot = await seedDot(db, "golf", 20040);
    expect(await db.secrets.openRouterKey(dot.id)).toBeNull();
    await db.secrets.put("global", "openrouter_api_key", "sk-global");
    expect(await db.secrets.openRouterKey(dot.id)).toBe("sk-global");
    await db.secrets.put(dot.id, "openrouter_api_key", "sk-dot");
    await db.secrets.put(dot.id, "openrouter_api_key", "sk-dot-2");
    expect(await db.secrets.openRouterKey(dot.id)).toBe("sk-dot-2");
    const { rows } = await db.pool.query("SELECT value_enc FROM secrets");
    for (const row of rows) expect(Buffer.from(row.value_enc).toString("latin1")).not.toContain("sk-");
    expect(await db.secrets.delete(dot.id, "openrouter_api_key")).toBe(true);
    expect(await db.secrets.openRouterKey(dot.id)).toBe("sk-global");
  });

  it("deleting a Dot cascades to its computer, tasks and approvals but keeps its events", async () => {
    const dot = await seedDot(db, "hotel", 20050);
    await db.tasks.insert({ id: newId("task"), dotId: dot.id, description: "x" });
    await db.events.insertHost(dot.id, "dot.deleted", { name: "hotel" });
    expect(await db.dots.delete(dot.id)).toBe(true);
    expect(await db.computers.get(dot.id)).toBeNull();
    expect(await db.tasks.listByDot(dot.id)).toEqual([]);
    expect(await db.events.list({ dotId: dot.id })).toHaveLength(1);
  });

  it("a transaction rolls back when its function throws", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.dots.insert({ id: newId("dot"), config: parseDotConfig(yaml("india")), status: "CREATING" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.dots.resolve("india")).toBeNull();
  });
});
