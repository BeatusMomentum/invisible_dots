/**
 * The process boundary of the builder: the two calls it makes into the host.
 * It is the shape of the vm-manager's CommandRunner, declared here rather
 * than imported so this package's logic loads without the vm-manager; the
 * real runner is the vm-manager's (see host.ts), and tests pass a fake.
 */

export interface RunningProcess {
  readonly pid: number | undefined;
  /** The last few KiB of stderr, for error messages when the process dies. */
  stderrTail(): string;
  /** Called once when the process exits or fails to start; `code` is null when killed by a signal. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null, error?: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface ProcessRunner {
  /** Runs to completion; rejects unless the command exits 0. Argument arrays only, never a shell. */
  run(command: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  /** `cwd` is the child's working directory: never inherited, see the vm-manager's startProcess. */
  spawn(command: string, args: readonly string[], options: { cwd: string }): RunningProcess;
}

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function waitForExit(child: RunningProcess): Promise<ExitStatus> {
  return new Promise((resolve) => child.onExit((code, signal, error) => resolve(error ? { code, signal, error } : { code, signal })));
}
