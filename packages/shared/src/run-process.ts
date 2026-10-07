/**
 * The one way a program is started on the host (Node-only): the vm-manager's
 * runners, the command's doctor and setup, and the secret files' ACL on
 * Windows all go through `runProcess`, with an argument array and never a
 * shell, so a path or an id is never read as shell syntax.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface RunOptions {
  /** Kill the process after this many milliseconds and report `timedOut`. No limit when absent. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * Hand the terminal to the child (stdin, stdout and stderr), for commands
   * that may ask the person something, such as sudo's password prompt.
   * Nothing is captured then.
   */
  inheritStdio?: boolean;
}

export interface RunResult {
  /** Exit code, or null when the process was killed by a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not be started at all (for example ENOENT). */
  startError?: NodeJS.ErrnoException;
}

/** Output beyond this is dropped: no command the host runs prints more, and a runaway one must not fill memory. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

/**
 * Run a program to completion and collect what it said. It never rejects:
 * a failure to start, a non-zero exit and a timeout are all in the result,
 * because callers such as doctor report each of them in their own words.
 * stdin is closed at once, so a program that reads it sees end of input
 * instead of waiting forever.
 */
export function runProcess(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        stdio: options.inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, startError: error as NodeJS.ErrnoException });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let startError: NodeJS.ErrnoException | undefined;
    let settled = false;
    const append = (current: string, chunk: Buffer) => (current.length >= MAX_OUTPUT_CHARS ? current : current + chunk.toString());
    child.stdout?.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ...(startError ? { startError } : {}) });
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      startError = error;
      // A process that never started emits no "close" on every Node version.
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    if (child.stdin) {
      // A child that exits before reading its input closes the pipe under us; that is its answer, not ours to report.
      child.stdin.on("error", () => undefined);
      child.stdin.end();
    }
  });
}
