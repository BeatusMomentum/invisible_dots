/** Fakes at the process boundary: a runner that records every command line and answers from a script. */
import type { CheckResult, DoctorDeps, FoundQemu } from "../src/doctor/checks.js";
import type { RunOptions, RunResult } from "@invisible-dots/vm-manager";

export interface RecordedRun {
  command: string;
  args: readonly string[];
  options: RunOptions;
}

export type Answer = Partial<RunResult>;

export function answer(partial: Answer = {}): RunResult {
  return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...partial };
}

/** A runner whose answers come from `respond`; every call is kept in `calls`. */
export function fakeRunner(respond: (command: string, args: readonly string[], options: RunOptions) => Answer | Promise<Answer>) {
  const calls: RecordedRun[] = [];
  const run = async (command: string, args: readonly string[], options: RunOptions = {}) => {
    calls.push({ command, args, options });
    return answer(await respond(command, args, options));
  };
  return { run, calls };
}

export const QEMU = "/opt/qemu/bin/qemu-system-x86_64";
export const QEMU_IMG = "/opt/qemu/bin/qemu-img";
export const FOUND: FoundQemu = { system: QEMU, img: QEMU_IMG, searched: ["INVISIBLE_DOTS_QEMU_DIR", "PATH"] };

export function ok(id: CheckResult["id"], label: string, detail = "fine"): CheckResult {
  return { id, label, status: "ok", detail };
}

/** A host where every check passes; tests override one dependency at a time. */
export function healthyDoctor(overrides: Partial<DoctorDeps> = {}) {
  const runner = fakeRunner((command, args) => {
    if (args[0] === "--version") {
      return { stdout: command === QEMU ? "QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)\nCopyright\n" : "qemu-img version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)\n" };
    }
    // The probe: the firmware found nothing to boot and its reset ended QEMU (section 11.1).
    return { code: 0 };
  });
  const deps: DoctorDeps = {
    nodeVersion: "24.19.0",
    accelerator: () => "kvm",
    findQemu: async () => FOUND,
    run: runner.run,
    acceleratorAccess: async () => ok("accelerator", "accelerator", "/dev/kvm opens read-write"),
    home: "/home/someone/.invisible-dots",
    freeSpace: async () => ({ path: "/home/someone/.invisible-dots", bytes: 100 * 1024 ** 3 }),
    images: async () => [ok("golden-image", "golden image", "golden-1.qcow2 matches its manifest"), ok("runtime-image", "runtime ISO", "runtime-1.iso matches its manifest")],
    openRouterKey: async () => ok("openrouter", "OpenRouter key", "stored"),
    ...overrides,
  };
  return { deps, calls: runner.calls };
}
