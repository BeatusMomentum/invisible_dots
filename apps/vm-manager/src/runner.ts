/**
 * The process runners of the host side. Every program the control plane
 * and the CLI start goes through this file or the `runProcess` it is built
 * on (packages/shared, so the secret files' ACL can use it too): short
 * commands (qemu-img, QEMU's --version, PowerShell, sudo apt-get) through
 * `runProcess`, a long-running child the caller watches (the image builder's
 * VM) through `startProcess`, and a Dot's QEMU, which must outlive the
 * control plane, through ProcessControl. All take argument arrays, never a shell, so a dot id or a
 * path can never be read as shell syntax, and tests swap the interfaces
 * (CommandRunner, ProcessControl) for fakes that record argv.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { processPresence, runProcess, type ProcessPresence, type RunOptions, type RunResult } from "@invisible-dots/shared";
import { CommandError } from "./errors.js";

export { runProcess, type RunOptions, type RunResult };

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /** Run a command to completion. Rejects with CommandError unless it exits 0. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** The real CommandRunner: `runProcess`, with a default timeout and a non-zero exit turned into a CommandError. */
export class NodeCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const result = await runProcess(command, args, { ...options, timeoutMs });
    if (result.code === 0 && !result.timedOut) return { stdout: result.stdout, stderr: result.stderr };
    throw new CommandError({
      command,
      args,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      code: result.startError?.code,
      message: result.timedOut ? `timed out after ${timeoutMs} ms` : undefined,
      cause: result.startError,
    });
  }
}

/** A long-running child the caller watches: its exit is reported once, its stderr kept as a short tail. */
export interface StartedProcess {
  readonly pid: number | undefined;
  /** The last few KiB of stderr, for error messages when the process dies. */
  stderrTail(): string;
  /** Called once when the process exits or fails to start; immediately when that already happened. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null, error?: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

const STDERR_TAIL_CHARS = 4096;

export interface StartProcessOptions {
  /**
   * The child's working directory. Always given: an inherited one is held
   * open by the child for its whole life, and on Windows that blocks moving
   * or deleting whatever directory the parent happened to start in.
   */
  cwd: string;
  /** The child's whole environment (an allowlist, see allowlistedEnvironment). */
  env: Record<string, string>;
}

export function startProcess(command: string, args: readonly string[], options: StartProcessOptions): StartedProcess {
  let tail = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | undefined;
  const listeners: ((code: number | null, signal: NodeJS.Signals | null, error?: Error) => void)[] = [];
  const settle = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
    if (exit) return;
    exit = error ? { code, signal, error } : { code, signal };
    for (const listener of listeners.splice(0)) listener(code, signal, error);
  };
  let child: ChildProcess;
  try {
    child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, cwd: options.cwd, env: options.env });
  } catch (error) {
    settle(null, null, error as Error);
    return { pid: undefined, stderrTail: () => "", onExit: (l) => l(null, null, error as Error), kill: () => undefined };
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  child.on("error", (error) => settle(null, null, error));
  child.on("close", (code, signal) => settle(code, signal));
  return {
    get pid() {
      return child.pid;
    },
    stderrTail: () => tail,
    onExit(listener) {
      if (exit) listener(exit.code, exit.signal, exit.error);
      else listeners.push(listener);
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (!exit) child.kill(signal);
    },
  };
}

/** The first non-empty line of a program's error output, for one-line reports. */
export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A process started detached from the control plane. */
export interface DetachedProcess {
  readonly pid: number;
  /**
   * Settles when the process exits while this control plane still runs. It
   * never rejects; after a control plane restart nobody holds this promise
   * and liveness is read from the pid instead.
   */
  readonly exited: Promise<ProcessExit>;
}

export interface SpawnDetachedOptions {
  /** stdout and stderr are appended to this file, so QEMU's messages survive the control plane. */
  logPath: string;
  /**
   * The working directory. A detached QEMU outlives the server, and on
   * Windows a process's working directory cannot be moved or deleted while
   * it runs, so it is never the server's own (which may be a checkout or a
   * removable drive): the caller passes one of its own directories.
   */
  cwd: string;
  /** The whole environment of the child: an allowlist, never the server's own (it may hold the API token or DATABASE_URL). */
  env: Record<string, string>;
}

export interface ProcessControl {
  /** Start a process in its own session, not tied to this process's lifetime. Rejects when it cannot be started at all. */
  spawnDetached(command: string, args: readonly string[], options: SpawnDetachedOptions): Promise<DetachedProcess>;
  /**
   * What `process.kill(pid, 0)` says about the pid, the same on both hosts:
   * gone, ours (this user may signal it) or foreign (it exists and belongs
   * to another user). A QEMU this control plane spawned is always ours.
   */
  presence(pid: number): ProcessPresence;
  /** Kill the process outright (SIGKILL; TerminateProcess on Windows). A missing process is not an error. */
  kill(pid: number): void;
}

/**
 * The real ProcessControl. `detached: true` matters on both hosts: on Linux
 * it puts QEMU in a new session, so a Ctrl-C to the server does not reach it;
 * on Windows it keeps libuv from placing QEMU in the job object that is
 * closed, and its processes killed, when the server exits.
 */
export class NodeProcessControl implements ProcessControl {
  async spawnDetached(command: string, args: readonly string[], options: SpawnDetachedOptions): Promise<DetachedProcess> {
    const fd = openSync(options.logPath, "a", 0o600);
    try {
      const child = spawn(command, [...args], {
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        cwd: options.cwd,
        env: options.env,
      });
      const exited = new Promise<ProcessExit>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", () => resolve({ code: null, signal: null }));
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error: NodeJS.ErrnoException) =>
          reject(new CommandError({ command, args, exitCode: null, code: error.code, cause: error })),
        );
      });
      // The control plane must be able to exit while QEMU keeps running.
      child.unref();
      return { pid: child.pid!, exited };
    } finally {
      closeSync(fd);
    }
  }

  presence(pid: number): ProcessPresence {
    return processPresence(pid);
  }

  kill(pid: number): void {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export { retryWhileInUse } from "@invisible-dots/shared";

/** Size of a file, 0 when it does not exist: where this start's output begins in an appended log. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
