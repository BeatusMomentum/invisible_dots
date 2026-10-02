import { fileURLToPath } from "node:url";
import { httpOverSocket, testSocketPath } from "@invisible-dots/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecFileRunner,
  VsockBridge,
  bridgeArgs,
  silentLogger,
  type CommandRunner,
  type SpawnOptions,
} from "../src/index.js";
import { FakeRunner } from "./fakes.js";

const FAKE_SOCAT = fileURLToPath(new URL("./fake-socat.mjs", import.meta.url));

/** Runs the real ExecFileRunner, but "socat" is our Node stand-in with extra env. */
function socatRunner(env: Record<string, string> = {}): CommandRunner & { spawns: string[][] } {
  const real = new ExecFileRunner();
  const spawns: string[][] = [];
  return {
    spawns,
    run: (command, args, options) => real.run(command, args, options),
    spawn: (command, args, options?: SpawnOptions) => {
      expect(command).toBe("socat");
      spawns.push([...args]);
      return real.spawn(process.execPath, [FAKE_SOCAT, ...args], { ...options, env: { ...process.env, ...env } });
    },
  };
}

const bridges: VsockBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

function makeBridge(runner: CommandRunner, socketPath: string, extra: Partial<ConstructorParameters<typeof VsockBridge>[0]> = {}) {
  const bridge = new VsockBridge({ dotId: "dot_a", cid: 10009, socketPath, runner, logger: silentLogger, ...extra });
  bridges.push(bridge);
  return bridge;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("vsock bridge", () => {
  it("uses the socat command line of section 5.1", () => {
    expect(bridgeArgs("/run/invisible-dots/dot-x.sock", 10001)).toEqual([
      "UNIX-LISTEN:/run/invisible-dots/dot-x.sock,fork,mode=600",
      "VSOCK-CONNECT:10001:1024",
    ]);
  });

  it("starts socat, waits for the socket and serves through it", async () => {
    const runner = socatRunner();
    const socket = testSocketPath("bridge");
    const bridge = makeBridge(runner, socket);
    await bridge.start();
    expect(bridge.running).toBe(true);
    expect(runner.spawns).toEqual([[`UNIX-LISTEN:${socket},fork,mode=600`, "VSOCK-CONNECT:10009:1024"]]);
    const answer = await httpOverSocket(socket, { path: "/v1/health", timeoutMs: 5000 });
    expect(answer.body.toString()).toBe("ok");

    await bridge.stop();
    expect(bridge.running).toBe(false);
    await expect(httpOverSocket(socket, { path: "/", timeoutMs: 2000 })).rejects.toThrow();
  });

  it("restarts socat when it dies on its own", async () => {
    const runner = socatRunner({ FAKE_SOCAT_EXIT_AFTER_MS: "300" });
    const socket = testSocketPath("bridge-restart");
    const bridge = makeBridge(runner, socket, { restartDelayMs: 20 });
    await bridge.start();
    const deadline = Date.now() + 5000;
    while (bridge.restartCount < 1 && Date.now() < deadline) await sleep(20);
    expect(bridge.restartCount).toBeGreaterThanOrEqual(1);
    expect(runner.spawns.length).toBeGreaterThanOrEqual(2);
    await bridge.stop();
    const spawnsAtStop = runner.spawns.length;
    await sleep(400);
    expect(runner.spawns.length).toBe(spawnsAtStop);
  });

  it("reports socat's stderr when it dies before the socket appears, and does not retry", async () => {
    const runner = socatRunner({ FAKE_SOCAT_FAIL: "1" });
    const bridge = makeBridge(runner, testSocketPath("bridge-fail"), { restartDelayMs: 10 });
    await expect(bridge.start()).rejects.toThrow(/exited with code 1 before its socket appeared: fake-socat: E connect.*Connection refused/);
    await sleep(100);
    expect(runner.spawns).toHaveLength(1);
  });

  it("times out when the socket never appears", async () => {
    const runner = new FakeRunner();
    const bridge = makeBridge(runner, "/nowhere.sock", { readyTimeoutMs: 50, socketExists: async () => false });
    await expect(bridge.start()).rejects.toThrow(/did not appear within 50 ms/);
    expect(runner.spawned[0]!.killed).toContain("SIGTERM");
  });
});
