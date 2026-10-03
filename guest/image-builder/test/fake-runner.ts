// A ProcessRunner standing in for qemu-img and qemu-system-x86_64. It records
// every command line and does the one thing the builder relies on each
// program for: qemu-img convert writes its output file, and the builder VM
// writes its serial console and then exits (or hangs until killed).
import { appendFile, copyFile, stat } from "node:fs/promises";
import type { ProcessRunner, RunningProcess } from "../src/process.js";

export interface VmScript {
  /** Lines the "guest" prints on its serial console, in order. */
  console: string[];
  /** Exit code once the console is written; "hang" waits to be killed. */
  exit: number | "hang";
  stderr?: string;
}

export interface FakeRunner extends ProcessRunner {
  runs: Array<{ command: string; args: readonly string[] }>;
  spawns: Array<{ command: string; args: readonly string[]; cwd: string }>;
  kills: string[];
  /** Called when the VM is spawned, before it "boots", to inspect the files it was given. */
  onSpawn?: (args: readonly string[]) => Promise<void>;
}

export function serialPathOf(args: readonly string[]): string {
  const serial = args[args.indexOf("-serial") + 1] ?? "";
  return serial.replace(/^file:/, "");
}

export function fakeRunner(script: VmScript): FakeRunner {
  const runner: FakeRunner = {
    runs: [],
    spawns: [],
    kills: [],
    async run(command, args) {
      runner.runs.push({ command, args });
      if (args[0] === "resize") await stat(args[args.length - 2]!);
      if (args[0] === "convert") await copyFile(args[args.length - 2]!, args[args.length - 1]!);
      return { stdout: "", stderr: "" };
    },
    spawn(command, args, options): RunningProcess {
      runner.spawns.push({ command, args, cwd: options.cwd });
      const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
      let exited = false;
      const exit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (exited) return;
        exited = true;
        for (const listener of listeners) listener(code, signal);
      };
      void (async () => {
        await runner.onSpawn?.(args);
        for (const line of script.console) {
          await appendFile(serialPathOf(args), `${line}\r\n`);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        if (script.exit !== "hang") exit(script.exit, null);
      })();
      return {
        pid: 4242,
        stderrTail: () => script.stderr ?? "",
        onExit: (listener) => {
          listeners.push(listener);
        },
        kill: (signal = "SIGTERM") => {
          runner.kills.push(signal);
          exit(null, signal);
        },
      };
    },
  };
  return runner;
}
