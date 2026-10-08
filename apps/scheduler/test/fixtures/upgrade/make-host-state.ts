/**
 * Writes the control plane's database as a release leaves it, for test/upgrade.test.ts.
 *
 * Run it from the root of a checkout of the release (a worktree of its tag), against a PostgreSQL server
 * (it makes a database of its own there and prints its name), then dump that database, leaving out psql's
 * meta-commands and the dump's reset of search_path, which would outlive the load on PGlite:
 *
 *   DATABASE_URL=postgres://... npx tsx <this file> fixtures/upgrade/<release tag>/master.key
 *   pg_dump --inserts --no-owner --no-privileges <the database> | grep -v -e '^\\' -e "set_config('search_path'" \
 *     > fixtures/upgrade/<release tag>/host.sql
 *
 * It drives that release's scheduler, with a fake computer, through what a person's install holds: two
 * Dots (one stopped), a chat answered, a completed task, a task waiting for an approval, an approval
 * answered with "always", a cancelled task, an automation, a Telegram binding with its token, and the
 * OpenRouter key. The master key it writes is a test key: it only opens the secrets of the dump.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Database } from "@invisible-dots/database";
import { createScratchPostgres } from "@invisible-dots/database/testing";
import { Scheduler } from "../../../src/index.js";
import { FakeDriver, ManualClock, waitFor, waitUntilSettledReady } from "../../../src/testing.js";

const [keyFile] = process.argv.slice(2);
if (!keyFile) throw new Error("usage: make-host-state.ts <master key file to write>");
const masterKey = randomBytes(32);
const { url } = await createScratchPostgres();
const db = await Database.open({ target: { kind: "pg", url }, masterKey, poolSize: 5 });
await db.migrate();
const driver = new FakeDriver();
const scheduler = new Scheduler({
  db,
  driver,
  clock: new ManualClock(new Date("2026-10-07T09:00:00.000Z")),
  lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10, pumpMaxRetryMs: 50 },
  dispatcher: { retryDelayMs: 0, maxDeliveryAttempts: 2 },
});
await scheduler.setOpenRouterKey("sk-or-v1-upgrade-fixture-not-a-real-key");

const yaml = (name: string) =>
  `name: ${name}\nmodel:\n  provider: openrouter\n  id: z-ai/glm-5.3-flash\ncomputer:\n  idle_timeout: 15m\npermissions:\n  files.write: ask\n`;
const ready = async (name: string) => {
  const dot = await scheduler.createDot(yaml(name));
  await waitUntilSettledReady(scheduler, driver, dot.id, name);
  return dot;
};

const watcher = await ready("fare-watch");
const guest = driver.guestOf(watcher.id);

// A chat answered, and a completed task.
await scheduler.sendMessage(watcher.id, "Remember: my favourite colour is teal.");
const done = await scheduler.createTask(watcher.id, { description: "List the workspace." });
await waitFor(async () => (await db.tasks.get(done.id))?.status === "COMPLETED", "task completed");

// An approval answered with "always", and a task that waits for an approval when the release is upgraded.
const original = guest.onInbound;
guest.onInbound = (event, g) => {
  if (event.type !== "task.created") return original(event, g);
  g.emit("task.started", { task_id: event.data.task_id });
  g.requestApproval(event.data.task_id);
};
const allowed = await scheduler.createTask(watcher.id, { description: "Delete the old identity." });
const always = await waitFor(async () => (await scheduler.listApprovals("pending")).find((a) => a.task_id === allowed.id), "first approval");
await scheduler.resolveApproval(always.id, "approve", { always: true, note: "fine" });
await waitFor(async () => (await db.tasks.get(allowed.id))?.status === "COMPLETED", "approved task completed");
await scheduler.updateDot(watcher.id, yaml("fare-watch"));
const waiting = await scheduler.createTask(watcher.id, { description: "Delete the shop identity." });
await waitFor(async () => (await db.tasks.get(waiting.id))?.status === "WAITING_APPROVAL", "task waiting");

// A cancelled task, queued behind the waiting one.
const cancelled = await scheduler.createTask(watcher.id, { description: "Check the fares again." });
await scheduler.cancelTask(cancelled.id);

// An automation the Dot reported.
guest.putAutomation({
  id: "job_water",
  name: "water the plants",
  enabled: true,
  schedule: { kind: "every", every_ms: 86_400_000 },
  message: "Water the plants",
  next_run_at_ms: 1_791_505_433_167,
  last_run_at_ms: null,
  last_status: null,
  last_error: null,
  delete_after_run: false,
  created_at_ms: 1_791_419_033_167,
});

// A Telegram binding with its token and a paired owner.
const binding = await db.channels.createBinding({
  id: "chb_upgrade",
  dotId: watcher.id,
  kind: "telegram",
  settings: { approvals: true, notify_tasks: true, show_arguments: false },
  eventCursor: 0,
  account: "fare_watch_bot",
});
await db.secrets.put(watcher.id, "telegram_bot_token", "123456:upgrade-fixture-not-a-real-token");
await db.channels.upsertPeer({ bindingId: binding.id, peerId: "4242", chatId: "4242", role: "owner", label: "Federico" });

// A second Dot, stopped.
const minimal = await ready("minimal-dot");
await scheduler.stopComputer(minimal.id);
await waitFor(async () => (await db.computers.get(minimal.id))?.state === "STOPPED", "computer stopped");

await scheduler.settle();
await scheduler.close();
await db.close();
await writeFile(keyFile, masterKey.toString("hex") + "\n");
console.log(new URL(url).pathname.slice(1));
