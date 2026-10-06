/**
 * The host side of the accelerator (architecture section 1.1), read before
 * QEMU is asked to use it: /dev/kvm opened read-write on Linux, the
 * HypervisorPlatform optional feature on Windows. One of the two places that
 * ask which operating system this is (the other is `accelerator()` in
 * host.ts); `doctor` reports what it finds and `invisible-dots setup`
 * enables what it finds missing.
 */
import { open } from "node:fs/promises";
import type { DoctorCheck } from "@invisible-dots/shared";
import type { Runner } from "./doctor.js";
import { firstLine, runProcess } from "./runner.js";
import { HYPERVISOR_PLATFORM_FEATURE, HYPERVISOR_PLATFORM_STATE_SCRIPT, powershellArgs, powershellPath } from "./powershell.js";

const KVM_DEVICE = "/dev/kvm";
const USERMOD_COMMAND = "sudo usermod -aG kvm $USER";
const FEATURE_QUERY_TIMEOUT_MS = 60_000;
export const UNSUPPORTED_FIX = "run invisible_dots on Linux or Windows (x86-64)";

export interface AccessDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  run: Runner;
  /** Opens a path read-write and closes it again; rejects with the errno error. */
  openReadWrite(path: string): Promise<void>;
}

/** This machine: its platform, the real process runner and the real /dev/kvm. */
export function hostAccessDeps(env: Record<string, string | undefined>): AccessDeps {
  return {
    platform: process.platform,
    env,
    run: runProcess,
    openReadWrite: async (path) => {
      await (await open(path, "r+")).close();
    },
  };
}

/** The host side of the accelerator, before QEMU is asked to use it (doctor's "accelerator" check). */
export async function checkAcceleratorAccess(deps: AccessDeps): Promise<DoctorCheck> {
  if (deps.platform === "linux") return checkKvmDevice(deps);
  if (deps.platform === "win32") return checkHypervisorPlatform(deps);
  return {
    id: "accelerator",
    label: "accelerator",
    status: "failed",
    detail: `${deps.platform} hosts are not supported`,
    fix: UNSUPPORTED_FIX,
  };
}

export async function checkKvmDevice(deps: AccessDeps): Promise<DoctorCheck> {
  const base = { id: "accelerator", label: "accelerator" } as const;
  try {
    await deps.openReadWrite(KVM_DEVICE);
    return { ...base, status: "ok", detail: `${KVM_DEVICE} opens read-write` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ...base,
        status: "missing",
        detail: `${KVM_DEVICE} does not exist`,
        fix: "enable hardware virtualization (Intel VT-x or AMD-V) in the firmware settings, then: sudo modprobe kvm_intel (or kvm_amd)",
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ...base,
        status: "missing",
        detail: `${KVM_DEVICE} exists but this user cannot open it read-write`,
        fix: `${USERMOD_COMMAND}, then log out and in again (a new login is needed for the group to apply)`,
      };
    }
    return { ...base, status: "failed", detail: `opening ${KVM_DEVICE} failed: ${(error as Error).message}`, fix: "check the kvm kernel module (dmesg | grep -i kvm)" };
  }
}

async function checkHypervisorPlatform(deps: AccessDeps): Promise<DoctorCheck> {
  const base = { id: "accelerator", label: "accelerator" } as const;
  const answer = await deps.run(powershellPath(deps.env), powershellArgs(HYPERVISOR_PLATFORM_STATE_SCRIPT), { timeoutMs: FEATURE_QUERY_TIMEOUT_MS });
  if (answer.code !== 0) {
    const why = answer.timedOut ? "timed out" : (answer.startError?.message ?? (firstLine(answer.stderr) || `exit code ${answer.code}`));
    return { ...base, status: "failed", detail: `cannot read the ${HYPERVISOR_PLATFORM_FEATURE} feature state: ${why}` };
  }
  const state = answer.stdout.trim();
  if (state === "1") return { ...base, status: "ok", detail: `the ${HYPERVISOR_PLATFORM_FEATURE} feature is enabled` };
  if (state === "2") {
    return {
      ...base,
      status: "missing",
      detail: `the ${HYPERVISOR_PLATFORM_FEATURE} feature is disabled`,
      fix: "invisible-dots setup (enables it with one administrator prompt; a restart follows)",
    };
  }
  const detail =
    state === ""
      ? `this Windows does not list the ${HYPERVISOR_PLATFORM_FEATURE} feature`
      : `the ${HYPERVISOR_PLATFORM_FEATURE} feature is in state ${state} (3 means its files were removed from this Windows)`;
  return { ...base, status: "failed", detail, fix: "use a Windows 10 or 11 edition that offers Windows Hypervisor Platform" };
}
