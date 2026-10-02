import { CommandError, type CommandResult, type CommandRunner, type RunOptions, type SpawnedProcess } from "../src/index.js";

export interface RecordedCall {
  command: string;
  args: string[];
  options: RunOptions | undefined;
}

export type Handler = (command: string, args: string[]) => CommandResult | undefined | Promise<CommandResult | undefined>;

/** A failure as execFile would report it. */
export function fail(command: string, args: string[], stderr: string, exitCode = 1): never {
  throw new CommandError({ command, args, exitCode, stderr });
}

export function notFound(command: string, args: string[]): never {
  throw new CommandError({ command, args, exitCode: null, code: "ENOENT" });
}

export class FakeProcess implements SpawnedProcess {
  readonly pid = 4242;
  killed: string[] = [];
  private listeners: Array<(code: number | null, signal: NodeJS.Signals | null, error?: Error) => void> = [];
  private done = false;
  constructor(
    readonly command: string,
    readonly args: string[],
  ) {}
  stderrTail(): string {
    return "fake stderr";
  }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null, error?: Error) => void): void {
    this.listeners.push(listener);
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed.push(signal);
    this.exit(null, signal);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.done) return;
    this.done = true;
    queueMicrotask(() => {
      for (const listener of this.listeners) listener(code, signal);
    });
  }
}

/** Records every command; `handler` answers them (undefined means success with empty output). */
export class FakeRunner implements CommandRunner {
  calls: RecordedCall[] = [];
  spawned: FakeProcess[] = [];
  constructor(public handler: Handler = () => undefined) {}

  async run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult> {
    const copy = [...args];
    this.calls.push({ command, args: copy, options });
    return (await this.handler(command, copy)) ?? { stdout: "", stderr: "" };
  }

  spawn(command: string, args: readonly string[]): SpawnedProcess {
    const process = new FakeProcess(command, [...args]);
    this.spawned.push(process);
    return process;
  }

  /** Every call as one "command arg arg" line, for readable assertions. */
  lines(): string[] {
    return this.calls.map((call) => [call.command, ...call.args].join(" "));
  }
}
