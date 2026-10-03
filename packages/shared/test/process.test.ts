import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquirePidLock, hostRestartedSince, hostUptimeSeconds, processPresence } from "../src/index.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-pidlock-"));
  path = join(dir, "test.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const options = (presence?: (pid: number) => "gone" | "ours" | "foreign") => ({
  what: "test job",
  stopHint: "stop it",
  ...(presence ? { presence } : {}),
});

describe("processPresence", () => {
  it("knows this process, and a pid that cannot exist is gone", () => {
    expect(processPresence(process.pid)).toBe("ours");
    expect(processPresence(0)).toBe("gone");
    expect(processPresence(-5)).toBe("gone");
  });
});

describe("hostRestartedSince", () => {
  it("is true only for a record written at a higher uptime than now", () => {
    expect(hostRestartedSince(hostUptimeSeconds() + 3600)).toBe(true);
    expect(hostRestartedSince(0)).toBe(false);
    expect(hostRestartedSince(undefined)).toBe(false);
  });
});

describe("acquirePidLock", () => {
  it("two processes that both find a stale lock never both get it", { timeout: 60_000 }, async () => {
    // Each round, two acquirers race over the same stale lock; the old
    // "read, remove, create" let both win in about half of such rounds.
    for (let round = 0; round < 25; round++) {
      await writeFile(path, "999999\n");
      const results = await Promise.allSettled([
        acquirePidLock(path, options(() => "gone")),
        acquireFresh(path),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      expect(won.length, `round ${round}`).toBe(1);
      for (const r of won) await (r as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
      await rm(path, { force: true });
    }
  });

  it("takes over a lock that holds this process's own pid when this process does not hold it", async () => {
    // A recycled pid: an earlier process with the same pid left this behind.
    await writeFile(path, `${JSON.stringify({ pid: process.pid })}\n`);
    const lock = await acquirePidLock(path, options(() => "ours"));
    await expect(acquirePidLock(path, options())).rejects.toThrow(/already holds/);
    await lock.release();
  });

  it("takes over a lock written in an earlier boot even when its pid exists now", async () => {
    await writeFile(path, `${JSON.stringify({ pid: 4242, host_uptime_s: hostUptimeSeconds() + 86_400 })}\n`);
    const lock = await acquirePidLock(path, options(() => "foreign"));
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it("refuses while a live holder or its recorded child runs, naming the file to remove", async () => {
    await writeFile(path, `${JSON.stringify({ pid: 4242, host_uptime_s: 0 })}\n`);
    await expect(acquirePidLock(path, options((pid) => (pid === 4242 ? "foreign" : "gone")))).rejects.toThrow(
      new RegExp(`another test job is running \\(pid 4242\\); stop it, or remove .*test\\.lock`),
    );
    await writeFile(path, `${JSON.stringify({ pid: 4242, host_uptime_s: 0, child: 5151 })}\n`);
    await expect(acquirePidLock(path, options((pid) => (pid === 5151 ? "ours" : "gone")))).rejects.toThrow(
      /pid 5151\) still runs; stop pid 5151, then remove .*test\.lock/,
    );
  });

  it("records a child and releases only its own lock", async () => {
    const lock = await acquirePidLock(path, options());
    await lock.setChild(31337);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid, child: 31337 });
    await lock.setChild(null);
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("child");
    await writeFile(path, "4242\n");
    await lock.release();
    expect(await readFile(path, "utf8")).toBe("4242\n");
  });

  it("refuses a file it cannot read as a lock", async () => {
    await writeFile(path, "not a lock");
    await expect(acquirePidLock(path, options())).rejects.toThrow(/not a lock this version wrote.*remove/);
  });
});

/**
 * A second acquirer as another process would be: the in-process registry
 * keyed by path is bypassed by going through a link-free alias of the same
 * file (a different spelling of the path).
 */
async function acquireFresh(target: string) {
  return acquirePidLock(join(target, "..", "test.lock"), options(() => "gone"));
}
