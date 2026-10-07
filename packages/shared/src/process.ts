/**
 * Processes seen from outside, the same way on Linux and Windows, and the
 * pid lock files built on that (Node-only). One copy of each rule: the
 * server lock, the image build locks and the vm-manager's view of a QEMU
 * all ask these functions.
 */
import { randomBytes } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { uptime } from "node:os";
import { resolve } from "node:path";
import { replaceFile } from "./replace-file.js";

/**
 * What `process.kill(pid, 0)` says about a pid, which means the same on both
 * hosts: "gone" (no such process), "ours" (it exists and this process may
 * signal it: same user, or we are an administrator), "foreign" (it exists and
 * belongs to someone else, EPERM).
 */
export type ProcessPresence = "gone" | "ours" | "foreign";

export function processPresence(pid: number): ProcessPresence {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "gone";
  try {
    process.kill(pid, 0);
    return "ours";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "foreign" : "gone";
  }
}

/** Whether a process with this pid exists at all, whoever owns it. */
export function processExists(pid: number): boolean {
  return processPresence(pid) !== "gone";
}

/**
 * Seconds since the host booted. It only ever grows within one boot and
 * starts again from zero at the next, whatever happens to the wall clock, so
 * a record that stores it at write time can tell "written in an earlier boot"
 * without trusting the clock. (Windows Fast Startup keeps counting across a
 * shutdown; such a record falls back to the pid checks.)
 */
export function hostUptimeSeconds(): number {
  return uptime();
}

/** True when the host restarted after a record that stored `hostUptimeSeconds()` was written. */
export function hostRestartedSince(recordedUptimeSeconds: number | undefined): boolean {
  return typeof recordedUptimeSeconds === "number" && Number.isFinite(recordedUptimeSeconds) && hostUptimeSeconds() < recordedUptimeSeconds;
}

/** The content of a lock file: who holds it, when, and the child process it started, if any. */
export interface PidLockRecord {
  pid: number;
  host_uptime_s?: number;
  /** A process the holder started that must not outlive it unseen (the image builder's QEMU). */
  child?: number;
}

function parseRecord(text: string): PidLockRecord | undefined {
  const trimmed = text.trim();
  // Locks written before the record became JSON hold a bare pid.
  if (/^\d+$/.test(trimmed)) return { pid: Number(trimmed) };
  try {
    const value = JSON.parse(trimmed) as Partial<PidLockRecord>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    const record: PidLockRecord = { pid: value.pid as number };
    if (typeof value.host_uptime_s === "number") record.host_uptime_s = value.host_uptime_s;
    if (Number.isSafeInteger(value.child) && (value.child as number) > 0) record.child = value.child as number;
    return record;
  } catch {
    return undefined;
  }
}

function serialize(record: PidLockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export interface PidLock {
  readonly path: string;
  /** Record (or clear) the child process this holder started, so a later holder sees it. */
  setChild(pid: number | null): Promise<void>;
  /** Remove the lock, only while it is still this process's. */
  release(): Promise<void>;
}

export interface PidLockOptions {
  /** What the lock guards, for messages: "invisible-dots server", "golden image build". */
  what: string;
  /** How to stop the holder, for the message when one is running. */
  stopHint: string;
  /** File mode of the lock. Default 0600. */
  mode?: number;
  /** Replaced in tests. */
  presence?: (pid: number) => ProcessPresence;
}

/** Locks this process holds right now, so a second acquire in the same process is refused, not taken over. */
const held = new Set<string>();

/**
 * Take an exclusive lock file holding this process's pid, or fail naming the
 * holder and the file to remove. Node has no flock, and a file created with
 * O_EXCL behaves the same on Linux and Windows.
 *
 * A lock is stale, and taken over, when the host restarted since it was
 * written, or when its pid is gone and so is the child it records; a lock
 * that names this process's own pid can only be stale too (the pid of an
 * earlier process came back), unless this process holds it already.
 *
 * Taking over is not "remove, then create": two processes that both judged
 * the lock stale would each remove the other's new lock. Whoever creates
 * `<path>.takeover` first (O_EXCL again) is the only one allowed to remove
 * the stale lock, and only after reading it again unchanged; the other one
 * waits for it and finds the new holder.
 */
export async function acquirePidLock(path: string, options: PidLockOptions): Promise<PidLock> {
  const key = resolve(path);
  const alreadyHeld = () => new Error(`this process already holds the ${options.what} lock ${path}`);
  if (held.has(key)) throw alreadyHeld();
  const presence = options.presence ?? processPresence;
  const mode = options.mode ?? 0o600;
  const mine: PidLockRecord = { pid: process.pid, host_uptime_s: hostUptimeSeconds() };
  const marker = `${path}.takeover`;

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const handle = await open(path, "wx", mode);
      try {
        await handle.writeFile(serialize(mine));
      } finally {
        await handle.close();
      }
      held.add(key);
      return lockHandle(path, key, mine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const seen = await readFile(path, "utf8").catch(() => undefined);
    if (seen === undefined) continue; // removed meanwhile: try to create it again
    const record = parseRecord(seen);
    if (!record) {
      throw new Error(`${path} is not a lock this version wrote, so whether a ${options.what} runs is unknown; make sure none does, then remove ${path}`);
    }
    if (record.pid === process.pid && held.has(key)) throw alreadyHeld();
    const restarted = hostRestartedSince(record.host_uptime_s);
    if (!restarted && record.pid !== process.pid && presence(record.pid) !== "gone") {
      throw new Error(
        `another ${options.what} is running (pid ${record.pid}); ${options.stopHint}, ` +
          `or remove ${path} if pid ${record.pid} is not one`,
      );
    }
    if (!restarted && record.child !== undefined && presence(record.child) !== "gone") {
      throw new Error(
        `the ${options.what} of pid ${record.pid} is gone but the process it started (pid ${record.child}) still runs; ` +
          `stop pid ${record.child}, then remove ${path}`,
      );
    }

    // Stale. Only the one process that creates the marker may replace it.
    try {
      const handle = await open(marker, "wx", mode);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt >= 19) {
        throw new Error(`another process is taking over the stale lock ${path}; if none is, remove ${marker}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
      continue;
    }
    try {
      const again = await readFile(path, "utf8").catch(() => undefined);
      if (again === seen) await rm(path, { force: true });
    } finally {
      await rm(marker, { force: true });
    }
  }
  throw new Error(`cannot take the ${options.what} lock ${path}: it keeps changing; remove ${path} if no ${options.what} runs`);
}

function lockHandle(path: string, key: string, mine: PidLockRecord): PidLock {
  let current = mine;
  const stillOurs = async () => {
    const record = parseRecord((await readFile(path, "utf8").catch(() => "")) || "");
    return record?.pid === process.pid && record.host_uptime_s === mine.host_uptime_s;
  };
  return {
    path,
    async setChild(pid) {
      if (!(await stillOurs())) return;
      const { child: _child, ...rest } = current;
      current = pid === null ? rest : { ...rest, child: pid };
      // Written to a new file and renamed over, so a reader never sees half a record.
      const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(serialize(current));
      } finally {
        await handle.close();
      }
      await replaceFile(temporary, path);
    },
    async release() {
      held.delete(key);
      // Remove it only while it is still ours: a later process may own it after a takeover.
      if (await stillOurs()) await rm(path, { force: true });
    },
  };
}
