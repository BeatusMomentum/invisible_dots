/**
 * One process owns dot.db (architecture section 8.7), and schema version 2:
 * tool intents, context summaries and approvals found by their call's position.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DotStore, DotStoreLockedError, MIGRATIONS } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const dirs: string[] = [];
const children: ChildProcess[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "idots-lock-"));
  dirs.push(dir);
  return join(dir, "dot.db");
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A child process that opens the store and keeps it until it is killed. */
async function owner(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, join(here, "fixtures", "hold-store.ts"), path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`the owner exited with ${code}: ${stderr}`)));
  });
  return child;
}

describe("the dot.db lock", () => {
  it("a second store on the same dot.db fails at open", () => {
    const path = tempDb();
    const first = DotStore.open(path);
    expect(() => DotStore.open(path)).toThrow(DotStoreLockedError);
    expect(() => DotStore.open(path)).toThrow(`another agent owns ${path}`);
    first.close();
    const again = DotStore.open(path);
    again.close();
  });

  it("the lock is free as soon as the owner process dies", async () => {
    const path = tempDb();
    const child = await owner(path);
    expect(() => DotStore.open(path)).toThrow(DotStoreLockedError);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    const started = Date.now();
    const store = DotStore.open(path);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(store.getConfig("owner")).toBe(child.pid);
    store.close();
  }, 30_000);
});

describe("schema version 2", () => {
  it("keeps the approvals of a version 1 database, without a position, and lets one call id repeat", () => {
    const path = tempDb();
    const v1 = new DatabaseSync(path);
    v1.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    v1.exec(MIGRATIONS[0]!.sql);
    v1.prepare("INSERT INTO schema_migrations VALUES (1, 'initial', '2026-01-01T00:00:00Z')").run();
    v1.prepare(
      `INSERT INTO pending_approvals (approval_id, thread, task_id, tool_call_id, tool, permission, arguments, reason, status, note, created_at)
       VALUES ('apr_old', 't1', 't1', 'call_0', 'computer_exec', 'computer.exec', '{"command":"ls"}', 'asked', 'approved', 'fine', '2026-01-01T00:00:00Z')`,
    ).run();
    v1.close();

    const store = DotStore.open(path);
    expect(store.schemaVersion()).toBe(2);
    const old = store.getApproval("apr_old")!;
    expect(old).toMatchObject({ messageId: null, callIndex: null, status: "approved", note: "fine", arguments: { command: "ls" } });
    store.setApprovalPosition("apr_old", 4, 0);
    expect(store.getApprovalByCall("t1", 4, 0)?.approvalId).toBe("apr_old");
    // Providers reuse call ids across rounds: the same id at another position is another call.
    const base = { thread: "t1", taskId: "t1", toolCallId: "call_0", tool: "computer_exec", permission: "computer.exec" as const, arguments: {}, reason: "r" };
    store.insertPendingApproval({ ...base, approvalId: "apr_new", messageId: 9, callIndex: 0 });
    expect(store.getApprovalByCall("t1", 9, 0)?.approvalId).toBe("apr_new");
    expect(() => store.insertPendingApproval({ ...base, approvalId: "apr_dup", messageId: 9, callIndex: 0 })).toThrow();
    store.close();
  });

  it("records an intent once per call and counts the attempts of an interrupted one", () => {
    const store = DotStore.open(tempDb());
    const call = { thread: "t1", messageId: 3, callIndex: 1, toolCallId: "c", tool: "files_read", permission: "files.read", decision: "allow" };
    expect(store.recordIntent(call).attempts).toBe(1);
    expect(store.recordIntent(call).attempts).toBe(2);
    store.recordIntent({ ...call, callIndex: 0 });
    expect(store.listIntents("t1").map((i) => [i.callIndex, i.attempts])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    store.deleteIntent("t1", 3, 1);
    expect(store.getIntent("t1", 3, 1)).toBeUndefined();
    store.deleteIntentsForThread("t1");
    expect(store.listIntents("t1")).toEqual([]);
    store.close();
  });

  it("keeps a thread's summaries and reads the thread after the newest", () => {
    const store = DotStore.open(tempDb());
    const ids = [1, 2, 3, 4].map((n) => store.appendMessage("t1", { role: "user", content: `m${n}` }).id);
    expect(store.latestSummary("t1")).toBeUndefined();
    store.addSummary({ thread: "t1", uptoMessageId: ids[0]!, summary: "first", memoryKeys: [] });
    store.addSummary({ thread: "t1", uptoMessageId: ids[2]!, summary: "second", memoryKeys: ["k"] });
    const latest = store.latestSummary("t1")!;
    expect(latest).toMatchObject({ summary: "second", memoryKeys: ["k"] });
    expect(store.listMessages("t1", { afterId: latest.uptoMessageId }).map((m) => m.id)).toEqual([ids[3]]);
    expect(store.countMessages("t1", latest.uptoMessageId)).toBe(1);
    store.close();
  });
});
