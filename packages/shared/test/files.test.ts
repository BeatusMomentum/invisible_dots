import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDir, ensurePrivateDir, permissionBitsEnforced, readSecretFile, runProcess, writeSecretFile } from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("permissionBitsEnforced", () => {
  it("is the one stated platform difference", () => {
    expect(permissionBitsEnforced("linux")).toBe(true);
    expect(permissionBitsEnforced("win32")).toBe(false);
  });
});

describe("writeSecretFile and readSecretFile", () => {
  it("round-trips bytes and creates the missing directories", async () => {
    const path = join(dir, "config", "nested", "master.key");
    const key = new Uint8Array(32).map((_, i) => i * 7);
    await writeSecretFile(path, key);
    expect(Buffer.from(key).equals((await readSecretFile(path))!)).toBe(true);
    await writeSecretFile(join(dir, "config", "api.token"), "token-text\n");
    expect((await readSecretFile(join(dir, "config", "api.token")))!.toString("utf8")).toBe("token-text\n");
  });

  it("returns undefined for a missing file and throws for other errors", async () => {
    expect(await readSecretFile(join(dir, "absent.key"))).toBeUndefined();
    await expect(readSecretFile(dir)).rejects.toThrow();
  });

  it("replaces an existing secret and leaves no temporary file", async () => {
    const path = join(dir, "api.token");
    await writeSecretFile(path, "first");
    await writeSecretFile(path, "second");
    expect((await readSecretFile(path))!.toString()).toBe("second");
    expect(await readdir(dir)).toEqual(["api.token"]);
  });

  it("removes its temporary file when the write fails", async () => {
    // The target is an existing directory, so the final rename fails.
    const target = join(dir, "occupied");
    await ensureDir(join(target, "child"));
    await expect(writeSecretFile(target, "x")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["occupied"]);
  });

  it("sets 0600 on the file and 0700 on a directory it creates, where the system enforces them", async () => {
    const path = join(dir, "private", "master.key");
    // A secret that was readable by others is replaced by one that never was.
    await ensureDir(join(dir, "private"), 0o700);
    await writeFile(path, "old", { mode: 0o644 });
    await writeSecretFile(path, "new");
    await writeSecretFile(join(dir, "fresh", "api.token"), "t");
    if (!permissionBitsEnforced()) return;
    expect(await modeOf(path)).toBe(0o600);
    expect(await modeOf(join(dir, "fresh"))).toBe(0o700);
    expect(await modeOf(join(dir, "fresh", "api.token"))).toBe(0o600);
  });
});

describe("private files and directories", () => {
  it("are this user's alone on either host, also under a directory everybody may read", async () => {
    // On Windows a directory outside the profile (a drive root) inherits "Authenticated Users: Modify".
    const home = join(dir, "home");
    await ensurePrivateDir(home);
    await writeSecretFile(join(home, "config", "api.token"), "token-text\n");
    const file = join(home, "config", "api.token");
    if (permissionBitsEnforced()) {
      expect(await modeOf(home)).toBe(0o700);
      expect(await modeOf(file)).toBe(0o600);
      return;
    }
    const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    for (const path of [home, file]) {
      const listing = (await runProcess(icacls, [path], { timeoutMs: 30_000 })).stdout.replace(path, "");
      const entries = listing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes(":("));
      // One entry, inherited from nothing: the owner. No group, no other account.
      // The whole listing goes with a failure: an ACL that differs on another machine is only diagnosable from it.
      expect(entries, `icacls ${path}:\n${listing}`).toHaveLength(1);
      expect(entries[0]).toMatch(/:(?:\(OI\)\(CI\))?\(F\)$/);
      expect(entries.join(" ")).not.toMatch(/Users|Everyone|Authenticated|\(I\)/i);
    }
  });
});

describe("ensureDir", () => {
  it("creates nested directories and accepts existing ones", async () => {
    const path = join(dir, "a", "b", "c");
    await ensureDir(path);
    await ensureDir(path);
    expect((await stat(path)).isDirectory()).toBe(true);
  });
});
