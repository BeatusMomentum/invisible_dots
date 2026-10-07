import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILDER_ENGINE_LOCK, defaultAssetRoot } from "../src/assets.js";
import { normalizePackageName, parseHashedLock } from "../src/python-lock.js";

const lockText = readFileSync(join(defaultAssetRoot(), BUILDER_ENGINE_LOCK), "utf8");
const pyproject = readFileSync(join(defaultAssetRoot(), "..", "..", "invisible_engine_dots", "pyproject.toml"), "utf8");

/** The names in pyproject.toml's `dependencies = [...]` (the runtime ones, not the optional groups). */
function declaredDependencies(toml: string): string[] {
  const block = /^dependencies = \[\n([\s\S]*?)^\]/m.exec(toml);
  if (!block) throw new Error("pyproject.toml has no dependencies list");
  return block[1]!
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => /^"([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)![1]!);
}

describe("builder/engine-requirements.lock", () => {
  const packages = parseHashedLock(lockText, BUILDER_ENGINE_LOCK);

  it("pins every package with hashes, as the build script installs it (--require-hashes)", () => {
    expect(packages.size).toBeGreaterThan(20);
    for (const [name, version] of packages) expect(version, name).toMatch(/^\d/);
  });

  it("pins every dependency pyproject.toml declares, so an added dependency cannot ship unpinned", () => {
    const declared = declaredDependencies(pyproject);
    expect(declared.length).toBeGreaterThan(10);
    const missing = declared.filter((name) => !packages.has(normalizePackageName(name)));
    expect(missing).toEqual([]);
  });

  it("pins what an extra of a dependency needs (httpx[socks] brings socksio)", () => {
    expect(packages.has("socksio")).toBe(true);
  });

  it("holds none of the engine's development dependencies, which the golden image does not carry", () => {
    for (const name of ["pytest", "pytest-asyncio"]) expect(packages.has(name)).toBe(false);
  });

  it("says in its header how to regenerate it, with the guest's Python and wheels only", () => {
    const header = lockText.split("\n").filter((line) => line.startsWith("#")).join("\n");
    expect(header).toContain("uv pip compile invisible_engine_dots/pyproject.toml --generate-hashes");
    expect(header).toContain("--python-version 3.12");
    expect(header).toContain("--python-platform x86_64-manylinux_2_39");
    expect(header).toContain("--only-binary :all:");
  });
});
