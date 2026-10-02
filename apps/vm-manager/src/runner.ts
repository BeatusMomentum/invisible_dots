/**
 * The one door every host command goes through. Commands run with execFile
 * (argument arrays, never a shell), so a dot id or a path can never be read as
 * shell syntax, and tests swap the runner for a fake that records argv.
 */
import { execFile, spawn as spawnChild } from "node:child_process";
import { CommandError } from "./errors.js";

export interface RunOptions {
  /** Kill the command after this many milliseconds. Default 60 s. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
}

/** A long-running child process, e.g. one socat bridge. */
export interface SpawnedProcess {
  readonly pid: number | undefined;
  /** The last few KiB of stderr, for error messages when the process dies. */
  stderrTail(): string;
  /** Called once when the process exits or fails to start. `code` is null when killed by a signal. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null, error?: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface CommandRunner {
  /** Run a command to completion. Rejects with CommandError unless it exits 0. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
  /** Start a long-running command. */
  spawn(command: string, args: readonly string[], options?: SpawnOptions): SpawnedProcess;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

/** The real runner, backed by node:child_process. */
export class ExecFileRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    const timeout = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: "utf8",
          env: options.env ?? process.env,
          cwd: options.cwd,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr });
            return;
          }
          const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };
          const timedOut = err.killed === true && err.signal === "SIGKILL";
          reject(
            new CommandError({
              command,
              args,
              exitCode: typeof err.code === "number" ? err.code : null,
              stdout,
              stderr,
              timedOut,
              code: typeof err.code === "string" ? err.code : undefined,
              message: timedOut ? `timed out after ${timeout} ms` : undefined,
              cause: error,
            }),
          );
        },
      );
    });
  }

  spawn(command: string, args: readonly string[], options: SpawnOptions = {}): SpawnedProcess {
    const child = spawnChild(command, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
      env: options.env ?? process.env,
      windowsHide: true,
    });
    let tail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    let exited = false;
    const listeners: Array<(code: number | null, signal: NodeJS.Signals | null, error?: Error) => void> = [];
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (exited) return;
      exited = true;
      for (const listener of listeners) listener(code, signal, error);
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("exit", (code, signal) => finish(code, signal));
    return {
      pid: child.pid,
      stderrTail: () => tail,
      onExit: (listener) => {
        listeners.push(listener);
      },
      kill: (signal = "SIGTERM") => {
        if (!exited) child.kill(signal);
      },
    };
  }
}
