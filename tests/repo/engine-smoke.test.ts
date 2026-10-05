/**
 * The engine smoke lives in guest/image-builder/test/smoke/ and runs in CI (the
 * `smoke` job of .github/workflows/tests.yml). These checks keep the pieces
 * together: the files are there and reference nothing outside the repository,
 * the job runs the entry and the gate waits for it, and the entry exits
 * non-zero on a failed check and on a skipped one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const smoke = join(repo, "guest/image-builder/test/smoke");

const FILES = ["README.md", "run.sh", "prepare-engine.sh", "smoke.sh", "fake_openrouter.py", "host-stream.sh"];
const SCRIPTS = FILES.filter((name) => name !== "README.md");

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** The lines of a shell script or Python file that are not comments. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** The text of one job of the workflow, up to the next job. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe("the engine smoke", () => {
  it("is in the repository, with the README that says what it proves and how to run it", () => {
    for (const name of FILES) expect(existsSync(join(smoke, name)), name).toBe(true);
    const readme = read(join(smoke, "README.md"));
    expect(readme).toContain("guest/image-builder/test/smoke/run.sh");
    expect(readme).toContain("--archive");
    expect(readme).toContain("WSL");
    expect(readme).toContain(".github/workflows/tests.yml");
    expect(readme).toContain("SMOKE: <passed> passed, <failed> failed, <skipped> skipped");
  });

  it("is LF-only, because it runs on Linux", () => {
    for (const name of FILES) expect(readFileSync(join(smoke, name), "utf8"), name).not.toContain("\r");
  });

  it("points nowhere outside the repository and keeps no state between runs", () => {
    for (const name of SCRIPTS) {
      const text = code(read(join(smoke, name)));
      expect(text, name).not.toMatch(/\.local\/(smoke|port)|scratchpad|\/mnt\/[a-z]\/|\bC:[\\/]|~\//);
      expect(text, name).not.toMatch(/\brm\s+(-\w*[rR]\w*|--recursive)\b/);
    }
    // The entry names no fixed path on the host: a docker volume per run, a mktemp file for its log.
    expect(code(read(join(smoke, "run.sh")))).not.toMatch(/\/tmp\b/);
    expect(code(read(join(smoke, "prepare-engine.sh")))).not.toMatch(/\/tmp\b/);
  });

  it("builds the engine's environment with the repository's own script and lock, as provision.sh does", () => {
    const prepare = read(join(smoke, "prepare-engine.sh"));
    expect(prepare).toContain("build-engine-env.sh");
    expect(prepare).toContain("engine-requirements.lock");
    expect(prepare).toContain("pins.json");
    const provision = read(join(repo, "guest/image-builder/builder/provision.sh"));
    expect(provision).toContain("ENGINE_BUILD");
    expect(provision).toContain("ENGINE_LOCK");
  });

  it("is run by the smoke job of the workflow, and the gate needs that job", () => {
    const workflow = read(join(repo, ".github/workflows/tests.yml"));
    const smokeJob = job(workflow, "smoke");
    expect(smokeJob).toContain("runs-on: ubuntu-latest");
    expect(smokeJob).toContain("uses: actions/checkout@v4");
    expect(smokeJob).toMatch(/run: bash guest\/image-builder\/test\/smoke\/run\.sh\s*$/m);

    const gate = job(workflow, "gate");
    const needs = /needs: \[([^\]]*)\]/.exec(gate);
    expect(needs).not.toBeNull();
    const jobs = [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z][a-z-]*):$/gm)]
      .map((m) => m[1]!)
      .filter((name) => name !== "gate");
    const needed = needs![1]!.split(",").map((name) => name.trim());
    expect(needed).toContain("smoke");
    expect([...needed].sort()).toEqual([...jobs].sort());
    expect(gate).toContain(`names.length !== ${jobs.length}`);
  });

  it("exits non-zero on a failed check and on a skipped one, and prints the summary", () => {
    const checks = read(join(smoke, "smoke.sh"));
    expect(checks).toContain('echo "SMOKE: $PASS passed, $FAIL failed, $SKIP skipped"');
    expect(checks.trimEnd().split("\n").pop()).toBe('[ "$FAIL" = 0 ] && [ "$SKIP" = 0 ]');

    const entry = read(join(smoke, "run.sh"));
    // The container's status and the summary line must both say "nothing failed, nothing skipped,
    // something passed"; a run that never printed the summary is not a pass.
    expect(entry).toContain("^SMOKE: [1-9][0-9]* passed, 0 failed, 0 skipped$");
    expect(entry).toContain('[ "$status" -eq 0 ]');
    expect(entry.trimEnd().split("\n").pop()).toBe("exit 1");
  });
});
