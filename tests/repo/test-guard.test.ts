/**
 * .github/scripts/test-guard.mjs is what keeps a run that only looks green
 * (too few tests collected, a suite that skipped itself, a Go file a build
 * constraint left out) from passing, in CI and in the pre-push hook alike,
 * from the one floors file .github/test-floors.json.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const guard = join(repo, ".github", "scripts", "test-guard.mjs");
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function run(report: string, suite: string, floor: Record<string, unknown>): { code: number | null; out: string } {
  dir = mkdtempSync(join(tmpdir(), "idots-guard-"));
  const reportPath = join(dir, "report");
  const floorsPath = join(dir, "floors.json");
  writeFileSync(reportPath, report);
  writeFileSync(floorsPath, JSON.stringify({ [suite]: { [process.platform]: floor } }));
  const result = spawnSync(process.execPath, [guard, reportPath, "--suite", suite, "--floors", floorsPath], { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const vitestReport = (statuses: Array<[string, string]>) =>
  JSON.stringify({ testResults: [{ name: "a.test.ts", status: "passed", assertionResults: statuses.map(([fullName, status]) => ({ fullName, status })) }] });
const goEvents = (events: Array<[string, string]>) =>
  `${events.map(([test, action]) => JSON.stringify({ Action: action, Package: "example.com/m/agentd", Test: test })).join("\n")}\n`;

describe("test-guard", () => {
  it("accepts a vitest run that reaches its floor with only allowed skips", () => {
    const report = vitestReport([["a works", "passed"], ["b works", "passed"], ["windows only thing", "skipped"]]);
    expect(run(report, "vitest", { min_passed: 2, allow_skipped: "^windows only " }).code).toBe(0);
  });

  it("refuses a run below the floor, and a skip nobody allowed, although every test passed", () => {
    const below = run(vitestReport([["a works", "passed"]]), "vitest", { min_passed: 2, allow_skipped: "" });
    expect(below.code).toBe(1);
    expect(below.out).toMatch(/only 1 tests passed, the floor is 2/);
    const skipped = run(vitestReport([["a works", "passed"], ["b", "skipped"]]), "vitest", { min_passed: 1, allow_skipped: "" });
    expect(skipped.code).toBe(1);
    expect(skipped.out).toMatch(/skipped without being allowed to: b/);
  });

  it("counts go test -json events, a skipped test included", () => {
    const events = goEvents([["TestA", "pass"], ["TestB", "skip"]]);
    expect(run(events, "go", { min_passed: 1, allow_skipped: "^agentd TestB$" }).code).toBe(0);
    expect(run(events, "go", { min_passed: 1, allow_skipped: "" }).out).toMatch(/skipped without being allowed to: agentd TestB/);
    expect(run(events, "go", { min_passed: 2, allow_skipped: "^agentd TestB$" }).code).toBe(1);
  });

  it("is what CI and the hook run, with the floors of this checkout for both hosts", () => {
    const floors = JSON.parse(readFileSync(join(repo, ".github", "test-floors.json"), "utf8")) as Record<string, Record<string, { min_passed: number }>>;
    for (const suite of ["vitest", "go"]) {
      for (const host of ["linux", "win32"]) expect(floors[suite]?.[host]?.min_passed, `${suite} ${host}`).toBeGreaterThan(0);
    }
    expect(floors.postgres?.linux?.min_passed).toBeGreaterThan(0);
    const workflow = readFileSync(join(repo, ".github", "workflows", "tests.yml"), "utf8");
    for (const suite of ["vitest", "postgres", "go"]) expect(workflow).toMatch(new RegExp(`test-guard\\.mjs \\S+ --suite ${suite}\\b`));
    const hook = readFileSync(join(repo, ".githooks", "pre-push"), "utf8");
    expect(hook).toContain("npm run typecheck");
    expect(hook).toContain("node .github/scripts/test-guard.mjs tmp/vitest-report.json --suite vitest");
    expect(hook).toContain("node .github/scripts/test-guard.mjs tmp/go-test.json --suite go");
  });
});
