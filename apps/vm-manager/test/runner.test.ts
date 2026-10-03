import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandError, firstLine, NodeCommandRunner, NodeProcessControl, retryWhileInUse, runProcess, startProcess } from "../src/index.js";

const childOptions = { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } };

// The real spawn against the running Node: the same on every host, no shell involved.
const node = process.execPath;

describe("runProcess", () => {
  it("collects exit code, stdout and stderr", async () => {
    const result = await runProcess(node, ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"], { timeoutMs: 20_000 });
    expect(result).toEqual({ code: 3, signal: null, stdout: "out", stderr: "err", timedOut: false });
  });

  it("closes stdin at once, so a program reading it sees end of input", async () => {
    const result = await runProcess(node, ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.exit(4))"], { timeoutMs: 20_000 });
    expect(result.code).toBe(4);
  });

  it("passes env and cwd", async () => {
    const result = await runProcess(node, ["-e", "process.stdout.write(process.env.IDOTS_RUNNER_TEST+'|'+process.cwd())"], {
      env: { ...process.env, IDOTS_RUNNER_TEST: "seen" },
      cwd: process.execPath.replace(/[\\/][^\\/]+$/, ""),
      timeoutMs: 20_000,
    });
    expect(result.stdout.startsWith("seen|")).toBe(true);
  });

  it("kills a process that outlives its timeout and says so", async () => {
    const result = await runProcess(node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.code === null || result.code !== 0).toBe(true);
  });

  it("reports a program that does not exist instead of throwing", async () => {
    const result = await runProcess("invisible-dots-no-such-program-x", ["--version"]);
    expect(result.code).toBeNull();
    expect(result.startError?.code).toBe("ENOENT");
  });
});

describe("NodeCommandRunner", () => {
  const runner = new NodeCommandRunner();

  it("resolves with the output of a command that exits 0", async () => {
    expect(await runner.run(node, ["-e", "process.stdout.write('{\"a\":1}')"])).toEqual({ stdout: '{"a":1}', stderr: "" });
  });

  it("rejects with a CommandError carrying the exit code and stderr", async () => {
    const error = (await runner.run(node, ["-e", "process.stderr.write('bad disk');process.exit(2)"]).catch((e: unknown) => e)) as CommandError;
    expect(error).toBeInstanceOf(CommandError);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("exited with code 2: bad disk");
  });

  it("rejects a timeout and a missing program in their own words", async () => {
    const slow = (await runner.run(node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 200 }).catch((e: unknown) => e)) as CommandError;
    expect(slow.timedOut).toBe(true);
    expect(slow.message).toContain("timed out after 200 ms");
    const missing = (await runner.run("invisible-dots-no-such-program-x", []).catch((e: unknown) => e)) as CommandError;
    expect(missing.notFound).toBe(true);
    expect(missing.message).toContain("invisible-dots doctor");
  });
});

describe("startProcess", () => {
  it("reports the exit once and keeps the end of stderr", async () => {
    const child = startProcess(node, ["-e", "process.stderr.write('x'.repeat(10000)+'END');process.exit(5)"], childOptions);
    const exit = await new Promise<number | null>((resolve) => child.onExit((code) => resolve(code)));
    expect(exit).toBe(5);
    expect(child.stderrTail().endsWith("END")).toBe(true);
    expect(child.stderrTail().length).toBeLessThanOrEqual(4096);
    // A listener added after the exit is called at once.
    expect(await new Promise((resolve) => child.onExit((code) => resolve(code)))).toBe(5);
  });

  it("reports a program that cannot start through onExit", async () => {
    const child = startProcess("invisible-dots-no-such-program-x", [], childOptions);
    const error = await new Promise<Error | undefined>((resolve) => child.onExit((_code, _signal, e) => resolve(e)));
    expect((error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });
});

describe("NodeProcessControl.spawnDetached", () => {
  it("runs the child in the directory and with exactly the environment it is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "idots-detached-"));
    try {
      const logPath = join(dir, "child.log");
      const control = new NodeProcessControl();
      const child = await control.spawnDetached(
        node,
        ["-e", "process.stdout.write(JSON.stringify({ cwd: process.cwd(), token: process.env.INVISIBLE_DOTS_TOKEN ?? null, only: process.env.IDOTS_ONLY ?? null }))"],
        { logPath, cwd: dir, env: { PATH: process.env.PATH ?? "", IDOTS_ONLY: "yes" } },
      );
      await child.exited;
      const seen = JSON.parse(await readFile(logPath, "utf8")) as { cwd: string; token: string | null; only: string | null };
      expect(seen.cwd.toLowerCase()).toBe(dir.toLowerCase());
      expect(seen.only).toBe("yes");
      expect(seen.token).toBeNull();
      expect(control.presence(child.pid)).toBe("gone");
      expect(control.presence(process.pid)).toBe("ours");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("retryWhileInUse", () => {
  it("tries again while the file is in use, and gives every other error back at once", async () => {
    let calls = 0;
    const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    expect(
      await retryWhileInUse(async () => {
        calls++;
        if (calls < 3) throw busy;
        return "done";
      }, 5, 1),
    ).toBe("done");
    expect(calls).toBe(3);
    const missing = Object.assign(new Error("no such file"), { code: "ENOENT" });
    calls = 0;
    await expect(
      retryWhileInUse(async () => {
        calls++;
        throw missing;
      }, 5, 1),
    ).rejects.toBe(missing);
    expect(calls).toBe(1);
    await expect(retryWhileInUse(async () => Promise.reject(busy), 2, 1)).rejects.toBe(busy);
  });
});

describe("firstLine", () => {
  it("skips blank lines and trims", () => {
    expect(firstLine("\r\n  qemu: error one \r\nmore")).toBe("qemu: error one");
    expect(firstLine("")).toBe("");
  });
});
