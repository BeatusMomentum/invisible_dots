import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentUserSid, ensureDir, ensurePrivateDir, permissionBitsEnforced, readSecretFile, runProcess, writeSecretFile } from "../src/index.js";

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
  it("no account but this user can open them, also under a directory everybody may read", async () => {
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
    // Read as SDDL, by SID: account names are translated with the Windows display language.
    // SYSTEM (SY) and the local Administrators (BA) are allowed: like root on Linux they can open
    // any file anyway, and some machines (CI runners among them) grant them explicitly on every
    // new directory, where removing inheritance does not remove them.
    const ownerSid = await currentUserSid();
    // SDDL writes a few accounts by alias instead of SID: the built-in Administrator (RID 500, the
    // account CI runners use) is LA.
    const owners = ownerSid.endsWith("-500") ? [ownerSid, "LA"] : [ownerSid];
    const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    for (const path of [home, file]) {
      const saved = join(dir, "acl.txt");
      await runProcess(icacls, [path, "/save", saved], { timeoutMs: 30_000 });
      const sddl = (await readFile(saved)).toString("utf16le");
      const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
      const aces = [...(dacl?.[2] ?? "").matchAll(/\(([^)]*)\)/g)].map((m) => (m[1] ?? "").split(";"));
      const context = `${path}: ${sddl.trim()}`;
      expect(dacl?.[1], context).toContain("P");
      for (const [type, flags, , , , sid] of aces) {
        expect(flags, context).not.toContain("ID");
        expect([...owners, "SY", "BA", "S-1-5-18", "S-1-5-32-544"], context).toContain(sid);
        expect(type, context).toBe("A");
      }
      expect(aces.some(([, , rights, , , sid]) => owners.includes(sid ?? "") && rights === "FA"), context).toBe(true);
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
