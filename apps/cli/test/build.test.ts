import { describe, expect, it } from "vitest";
import { agentdBuildCommand, defaultRuntimeInputs } from "@invisible-dots/image-builder";
import { WEB_BUILD_COMMAND } from "@invisible-dots/vm-manager";
import { fakeRunner, type Answer } from "../../vm-manager/test/doctor-fakes.js";
import { buildAgent, buildWeb, GO_INSTALL_HINT, type BuildDeps } from "../src/setup/build.js";
import { webBuildScript } from "../src/web.js";

const REPO = "/repo";

function deps(respond: (command: string, args: readonly string[]) => Answer, options: { built?: boolean[] } = {}) {
  const runner = fakeRunner(respond);
  const built = [...(options.built ?? [false, true])];
  const result: BuildDeps = {
    run: runner.run,
    env: { PATH: "/usr/bin", HOME: "/home/someone" },
    repoRoot: REPO,
    node: "/usr/bin/node",
    webBuilt: async () => built.length > 1 ? built.shift()! : built[0]!,
  };
  return { deps: result, calls: runner.calls };
}

describe("the guest daemon build", () => {
  it("runs the image builder's go build command with its linux/amd64 environment added to the caller's", async () => {
    const { deps: d, calls } = deps(() => ({}));
    const step = await buildAgent(d);
    const build = agentdBuildCommand(REPO);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("go");
    expect(calls[0]!.args).toEqual(build.args);
    expect(calls[0]!.options.env).toEqual({ PATH: "/usr/bin", HOME: "/home/someone", CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" });
    expect(step).toEqual({ ok: true, lines: [`built ${defaultRuntimeInputs(REPO).agentdBinary}`] });
  });

  it("asks for Go, with both hosts' install commands, when it is not installed, and to open a new terminal", async () => {
    const missing = Object.assign(new Error("spawn go ENOENT"), { code: "ENOENT" });
    const { deps: d } = deps(() => ({ code: null, startError: missing }));
    const step = await buildAgent(d);
    expect(step.ok).toBe(false);
    expect(step.lines).toContain(GO_INSTALL_HINT);
    expect(GO_INSTALL_HINT).toContain("winget install -e --id GoLang.Go");
    expect(GO_INSTALL_HINT).toContain("sudo snap install go --classic");
    expect(step.lines.join("\n")).toContain("open a new terminal");
    expect(step.lines.join("\n")).toContain("invisible-dots setup --all");
  });

  it("shows the end of the compiler's complaint when the build fails", async () => {
    const stderr = Array.from({ length: 30 }, (_, i) => `error line ${i}`).join("\n");
    const { deps: d } = deps(() => ({ code: 1, stderr }));
    const step = await buildAgent(d);
    expect(step.ok).toBe(false);
    expect(step.lines[0]).toBe("building dot-agentd failed (exit code 1):");
    expect(step.lines).toHaveLength(11);
    expect(step.lines.at(-1)).toBe("  error line 29");
  });

  it("reports a build that ran out of time", async () => {
    const { deps: d } = deps(() => ({ code: null, timedOut: true }));
    expect((await buildAgent(d)).lines[0]).toBe("building dot-agentd failed (it did not finish within 15 minutes):");
  });
});

describe("the web client build", () => {
  it("skips a client that is built, and says how to build it again", async () => {
    const { deps: d, calls } = deps(() => ({}), { built: [true] });
    const step = await buildWeb(d);
    expect(calls).toEqual([]);
    expect(step.ok).toBe(true);
    expect(step.lines[0]).toContain(WEB_BUILD_COMMAND);
  });

  it("runs the web build script with node, no shell, Next's telemetry off and the person's terminal for its output", async () => {
    const { deps: d, calls } = deps(() => ({}));
    const step = await buildWeb(d);
    expect(step).toEqual({ ok: true, lines: ["built the web client"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/bin/node");
    expect(calls[0]!.args).toEqual([webBuildScript(REPO)]);
    expect(calls[0]!.options.env).toMatchObject({ PATH: "/usr/bin" });
    expect(calls[0]!.options.inheritStdio).toBe(true);
  });

  it("stops with the command to run again when the build fails", async () => {
    const { deps: d } = deps(() => ({ code: 1 }));
    const step = await buildWeb(d);
    expect(step.ok).toBe(false);
    expect(step.lines[0]).toBe("building the web client failed (exit code 1; its output is above)");
    expect(step.lines[1]).toContain("invisible-dots setup --all");
  });

  it("does not call a build done whose server files are not there", async () => {
    const { deps: d } = deps(() => ({}), { built: [false] });
    const step = await buildWeb(d);
    expect(step.ok).toBe(false);
    expect(step.lines[0]).toContain("not where invisible-dots looks");
    expect(step.lines[0]).toContain(WEB_BUILD_COMMAND);
  });
});
