/**
 * The doctor's dependencies on the real machine (architecture section 11.1):
 * QEMU discovery, the accelerator, the free disk space and the process
 * runner. What needs more than the vm-manager knows, the images' manifests
 * and the OpenRouter key, is handed in by the caller: the API process asks
 * its own Scheduler, `invisible-dots doctor` asks the running server.
 */
import { stat, statfs } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { ENV, type DoctorCheck } from "@invisible-dots/shared";
import { checkAcceleratorAccess, hostAccessDeps } from "./accelerator-access.js";
import type { DoctorDeps, FoundQemu } from "./doctor.js";
import { QemuNotFoundError } from "./errors.js";
import { accelerator, findQemu, isExecutableFile, QEMU_SYSTEM_NAMES, qemuSearchDirs } from "./host.js";
import { runProcess } from "./runner.js";

/**
 * The vm-manager's discovery, with each program reported separately for
 * doctor. findQemu stops at the first program it cannot find; the probe
 * passed as `exists` remembers qemu-system-x86_64 when it was found and only
 * qemu-img is missing, so doctor can still check its version.
 */
export async function locateQemu(env: Record<string, string | undefined>): Promise<FoundQemu> {
  const found = new Set<string>();
  const exists = async (path: string) => {
    const ok = await isExecutableFile(path);
    if (ok) found.add(path);
    return ok;
  };
  const configured = Boolean(env[ENV.QEMU_DIR]?.trim());
  try {
    const programs = await findQemu(env, exists);
    return { ...programs, searched: qemuSearchDirs(env), configured };
  } catch (error) {
    if (!(error instanceof QemuNotFoundError)) throw error;
    const system = [...found].find((path) => (QEMU_SYSTEM_NAMES as readonly string[]).includes(basename(path)));
    return { ...(system ? { system } : {}), searched: [...error.searched], configured };
  }
}

/** Free space where INVISIBLE_DOTS_HOME is or will be: its nearest existing directory, since doctor creates nothing. */
export async function freeSpace(home: string): Promise<{ path: string; bytes: number }> {
  let path = home;
  for (;;) {
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) break;
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  const fs = await statfs(path);
  return { path, bytes: fs.bavail * fs.bsize };
}

export interface HostDoctorOptions {
  env: Record<string, string | undefined>;
  /** INVISIBLE_DOTS_HOME, as `hostPaths` resolved it. */
  home: string;
  /** The golden image and the runtime ISO against their manifests, one row each. */
  images(): Promise<DoctorCheck[]>;
  /** The OpenRouter key row (`openRouterCheck` for a known answer). */
  openRouterKey(): Promise<DoctorCheck>;
}

export function hostDoctorDeps(options: HostDoctorOptions): DoctorDeps {
  return {
    nodeVersion: process.versions.node,
    // Asked when a check needs it: on an unsupported host it throws, and that check reports it.
    accelerator: () => accelerator(),
    findQemu: () => locateQemu(options.env),
    run: runProcess,
    acceleratorAccess: () => checkAcceleratorAccess(hostAccessDeps(options.env)),
    home: options.home,
    freeSpace: () => freeSpace(options.home),
    images: options.images,
    openRouterKey: options.openRouterKey,
  };
}
