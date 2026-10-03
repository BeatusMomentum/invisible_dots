import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceFile } from "../src/replace-file.js";

function failing(codes: string[]) {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    rename: async (from: string, to: string) => {
      calls.push([from, to]);
      const code = codes.shift();
      if (code !== undefined) throw Object.assign(new Error(`${code}: rename`), { code });
    },
  };
}

describe("replaceFile", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("replaces the destination with the temporary file's bytes", async () => {
    dir = await mkdtemp(join(tmpdir(), "replace-file-"));
    const destination = join(dir, "lock");
    await writeFile(destination, "old");
    await writeFile(`${destination}.tmp`, "new");
    await replaceFile(`${destination}.tmp`, destination);
    expect(await readFile(destination, "utf8")).toBe("new");
  });

  it("waits out a file another process holds for a moment (EPERM, EACCES, EBUSY on Windows)", async () => {
    const fake = failing(["EPERM", "EACCES", "EBUSY"]);
    await replaceFile("a.tmp", "a", { rename: fake.rename, delayMs: 1 });
    expect(fake.calls).toHaveLength(4);
  });

  it("reports the error once the attempts are used up, so a real lock is not hidden", async () => {
    const fake = failing(Array.from({ length: 100 }, () => "EPERM"));
    await expect(replaceFile("a.tmp", "a", { rename: fake.rename, attempts: 3, delayMs: 1 })).rejects.toMatchObject({ code: "EPERM" });
    expect(fake.calls).toHaveLength(3);
  });

  it("does not retry any other error", async () => {
    const fake = failing(["ENOENT"]);
    await expect(replaceFile("a.tmp", "a", { rename: fake.rename, delayMs: 1 })).rejects.toMatchObject({ code: "ENOENT" });
    expect(fake.calls).toHaveLength(1);
  });
});
