/**
 * A release's database under this control plane: what a person's install holds must open, migrate and
 * go on working after an upgrade. Each directory of test/fixtures/upgrade holds the database one release
 * left (host.sql, made by make-host-state.ts from that release's checkout) and the test master key its
 * secrets were sealed with.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database, loadMigrations, OPENROUTER_KEY_NAME, PgliteDb } from "@invisible-dots/database";
import { createScratchPostgres, testAdapters } from "@invisible-dots/database/testing";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/index.js";
import { FakeDriver, ManualClock } from "../src/testing.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/upgrade/", import.meta.url));
const RELEASES = readdirSync(FIXTURES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe.each(testAdapters())("a release's database under this control plane (%s)", (kind) => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  /** The release's database loaded as it was left, then opened and migrated by this build. */
  async function upgraded(release: string): Promise<Database> {
    const dump = readFileSync(join(FIXTURES, release, "host.sql"), "utf8");
    const masterKey = Buffer.from(readFileSync(join(FIXTURES, release, "master.key"), "utf8").trim(), "hex");
    let db: Database;
    if (kind === "pglite") {
      const dataDir = mkdtempSync(join(tmpdir(), "idots-upgrade-"));
      cleanup.push(async () => rmSync(dataDir, { recursive: true, force: true }));
      const loader = await PgliteDb.open(dataDir);
      await loader.exec(dump);
      await loader.close();
      db = await Database.open({ target: { kind: "pglite", dataDir }, masterKey });
    } else {
      const { url, drop } = await createScratchPostgres();
      cleanup.push(drop);
      const loader = new pg.Client({ connectionString: url });
      await loader.connect();
      await loader.query(dump);
      await loader.end();
      db = await Database.open({ target: { kind: "pg", url }, masterKey, poolSize: 3 });
    }
    cleanup.push(() => db.close());
    await db.migrate();
    return db;
  }

  it("has a release to upgrade from", () => {
    expect(RELEASES.length).toBeGreaterThan(0);
  });

  it.each(RELEASES)("%s: migrates to every migration of this build, and its Dots, configs, tasks and secrets read back", async (release) => {
    const db = await upgraded(release);
    const applied = (await db.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
    expect(applied).toEqual((await loadMigrations()).map((m) => m.version));

    const dots = await db.dots.list();
    expect(dots.map((d) => d.name).sort()).toEqual(["fare-watch", "minimal-dot"]);
    const watcher = dots.find((d) => d.name === "fare-watch")!;
    expect(watcher.config.model.id).toBe("z-ai/glm-5.3-flash");
    expect(watcher.config.permissions?.["files.write"]).toBe("ask");
    expect((await db.computers.get(dots.find((d) => d.name === "minimal-dot")!.id))?.state).toBe("STOPPED");

    const tasks = await db.tasks.listByDot(watcher.id, { limit: 50 });
    expect(tasks.map((t) => t.status).sort()).toEqual(["CANCELLED", "COMPLETED", "COMPLETED", "WAITING_APPROVAL"]);

    // The secrets open with the key they were sealed with.
    expect(await db.secrets.get("global", OPENROUTER_KEY_NAME)).toBe("sk-or-v1-upgrade-fixture-not-a-real-key");
    expect(await db.secrets.get(watcher.id, "telegram_bot_token")).toBe("123456:upgrade-fixture-not-a-real-token");
    const [binding] = await db.channels.listBindings(watcher.id);
    expect(binding).toMatchObject({ kind: "telegram", account: "fare_watch_bot" });
    expect((await db.channels.peers(binding!.id)).map((p) => [p.peer_id, p.role])).toEqual([["4242", "owner"]]);
  });

  it.each(RELEASES)("%s: the approval it left pending is answered, new work is queued, and new events follow the old ones", async (release) => {
    const db = await upgraded(release);
    const scheduler = new Scheduler({ db, driver: new FakeDriver(), clock: new ManualClock(new Date("2026-11-01T09:00:00.000Z")) });
    cleanup.push(() => scheduler.close());
    const watcher = await scheduler.requireDot("fare-watch");
    const lastEvent = (await db.query<{ id: string }>("SELECT max(id)::text AS id FROM events")).rows[0]!.id;

    const [pending] = await scheduler.listApprovals("pending");
    expect(pending).toMatchObject({ dot_id: watcher.id, status: "pending", tool: "browser_identity_delete" });
    const resolved = await scheduler.resolveApproval(pending!.id, "approve", { note: "after the upgrade" });
    expect(resolved.status).toBe("approved");
    const queued = (await db.query<{ type: string; data: { approval_id?: string } }>("SELECT type, data FROM inbound_events WHERE dot_id = $1 AND sent_at IS NULL", [watcher.id])).rows;
    expect(queued.some((row) => row.type === "approval.received" && row.data.approval_id === pending!.id)).toBe(true);

    const task = await scheduler.createTask("fare-watch", { description: "Check the fares after the upgrade." });
    expect(task.status).toBe("PENDING");
    const conversation = await scheduler.conversation("fare-watch");
    expect(JSON.stringify(conversation)).toContain("Remember: my favourite colour is teal.");

    const events = await scheduler.listEvents(watcher.id, { after: Number(lastEvent) });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["approval.resolved", "task.created"]));
  });
});
