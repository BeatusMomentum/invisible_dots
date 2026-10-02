import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError, VmManager, type CommandResult, type CommandRunner, type SpawnedProcess } from "@invisible-dots/vm-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, latestImage, loadApiToken, parseListen, readServerEnv, VmManagerDriver } from "../src/index.js";

/** Answers virsh like a host where the domain is shut off; records every command. */
class ScriptedRunner implements CommandRunner {
  lines: string[] = [];
  domstate = "shut off";
  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.lines.push([command, ...args].join(" "));
    if (command === "virsh" && args.includes("domstate")) {
      if (this.domstate === "missing") {
        throw new CommandError({ command, args, exitCode: 1, stderr: "error: failed to get domain 'x'" });
      }
      return { stdout: `${this.domstate}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
  spawn(): SpawnedProcess {
    throw new Error("no bridges in this test");
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-images-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("image selection", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("2026.10.1", "2026.9.3")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.10")).toBeLessThan(0);
  });

  it("picks the newest golden image and runtime ISO, and says how to build one when none exists", async () => {
    for (const name of ["golden-2026.9.0.qcow2", "golden-2026.10.0.qcow2", "runtime-1.2.iso", "runtime-1.10.iso", "noise.txt"]) {
      await writeFile(join(dir, name), "");
    }
    const vm = new VmManager({ runner: new ScriptedRunner(), env: {}, logger: undefined });
    const driver = new VmManagerDriver(vm, { imagesDir: dir });
    expect(await driver.latestGolden()).toBe(join(dir, "golden-2026.10.0.qcow2"));
    expect(await driver.latestRuntime()).toBe(join(dir, "runtime-1.10.iso"));
    await expect(latestImage(join(dir, "missing"), /^x-(.+)$/, "golden image")).rejects.toThrow(/cannot list/);
    await rm(join(dir, "runtime-1.2.iso"));
    await rm(join(dir, "runtime-1.10.iso"));
    await expect(driver.latestRuntime()).rejects.toThrow(/no runtime ISO .* guest\/image-builder/);
  });
});

describe("VmManagerDriver over VmManager", () => {
  it("maps virsh domstate to the contract's VM states", async () => {
    const runner = new ScriptedRunner();
    const driver = new VmManagerDriver(new VmManager({ runner, env: {} }), { imagesDir: dir });
    expect(await driver.state("dot_abc")).toEqual({ defined: true, state: "STOPPED", detail: "shut off" });
    runner.domstate = "running";
    expect(await driver.state("dot_abc")).toEqual({ defined: true, state: "RUNNING", detail: "running" });
    runner.domstate = "missing";
    expect(await driver.state("dot_abc")).toMatchObject({ defined: false });
    expect(runner.lines[0]).toMatch(/^virsh -c \S+ domstate invisible-dot-dot_abc$/);
  });

  it("hands out vm-manager's GuestClient as the guest API", () => {
    const vm = new VmManager({ runner: new ScriptedRunner(), env: {}, bridgeSocketPath: () => "/tmp/x.sock" });
    const guest = new VmManagerDriver(vm, { imagesDir: dir }).guest("dot_abc", "token");
    expect(typeof guest.health).toBe("function");
    expect(typeof guest.events).toBe("function");
  });
});

describe("server settings", () => {
  it("parses the listen address", () => {
    expect(parseListen()).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(parseListen("0.0.0.0:9000")).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(parseListen("[::1]:8787")).toEqual({ host: "::1", port: 8787 });
    expect(parseListen("8080")).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(() => parseListen("localhost:http")).toThrow(/INVISIBLE_DOTS_LISTEN/);
  });

  it("loads the API token from the environment or api.token, refusing short ones", async () => {
    expect(await loadApiToken({ INVISIBLE_DOTS_TOKEN: "x".repeat(32) })).toBe("x".repeat(32));
    await expect(loadApiToken({ INVISIBLE_DOTS_TOKEN: "short" })).rejects.toThrow(/shorter/);
    await writeFile(join(dir, "api.token"), `${"a".repeat(64)}\n`);
    expect(await loadApiToken({ INVISIBLE_DOTS_CONFIG_DIR: dir })).toBe("a".repeat(64));
    await expect(loadApiToken({ INVISIBLE_DOTS_CONFIG_DIR: join(dir, "nope") })).rejects.toThrow(/cannot read the API token/);
  });

  it("reads server.env lines", async () => {
    const path = join(dir, "server.env");
    await writeFile(path, "# comment\nDATABASE_URL='postgres://u@h/db'\nexport INVISIBLE_DOTS_LISTEN=127.0.0.1:9999\nbroken line\n");
    expect(await readServerEnv(path)).toEqual({
      DATABASE_URL: "postgres://u@h/db",
      INVISIBLE_DOTS_LISTEN: "127.0.0.1:9999",
    });
    expect(await readServerEnv(join(dir, "missing.env"))).toEqual({});
  });
});
