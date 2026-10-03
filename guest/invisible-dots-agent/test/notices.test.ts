/**
 * The bundle's license notices (architecture section 11.3): generated from
 * esbuild's metafile, so every npm package an input comes from is listed with
 * its own license files, next to this repository's license and, when the
 * engine is in the bundle, Open Multi-Agent's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { noticesPath, thirdPartyNotices } from "../scripts/notices.mjs";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePackage(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.2.3", license: "BSD-2-Clause" }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return join(dir, "dist", "index.js");
}

describe("thirdPartyNotices", () => {
  it("lists every bundled package with its license files, and the engine's upstream", () => {
    const work = mkdtempSync(join(tmpdir(), "idots-notices-"));
    dirs.push(work);
    const a = fakePackage(work, "@scope/alpha", { LICENSE: "Copyright alpha\nBSD-2-Clause text", NOTICE: "alpha notice" });
    const b = fakePackage(work, "beta", {});
    const engine = join(repoRoot, "guest-runtime", "engine", "src", "agent", "runner.ts");
    const text = thirdPartyNotices({ metafile: { inputs: { [a]: {}, [b]: {}, [engine]: {}, "src/bin.ts": {} } }, workingDir: work, repoRoot });
    expect(text).toContain("== invisible_dots (MIT)");
    expect(text).toContain("== Open Multi-Agent (MIT)");
    expect(text).toContain("Copyright (c) Shenzhen YuanASI Technology Co., Ltd. and open-multi-agent contributors");
    expect(text).toContain("== @scope/alpha 1.2.3 (BSD-2-Clause)\n\nCopyright alpha\nBSD-2-Clause text\n\nalpha notice");
    expect(text).toContain('== beta 1.2.3 (BSD-2-Clause)\n\n(the package ships no license file; its package.json declares "BSD-2-Clause")');
    expect(noticesPath(join("dist", "invisible-dots-agent.mjs"))).toBe(join("dist", "THIRD_PARTY_NOTICES.txt"));
  });

  it("names the engine's upstream only when a derived file is in the bundle", () => {
    const own = join(repoRoot, "guest-runtime", "engine", "src", "dot", "driver.ts");
    const text = thirdPartyNotices({ metafile: { inputs: { [own]: {} } }, workingDir: repoRoot, repoRoot });
    expect(text).not.toContain("Open Multi-Agent");
  });
});
