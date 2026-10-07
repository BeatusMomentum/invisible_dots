/**
 * What the vm-manager needs from the host: where QEMU is and which
 * accelerator it uses. `accelerator()` is the only function in the vm-manager
 * whose answer depends on the operating system (architecture section 1.1);
 * QEMU discovery is the same search on every host over a list of directories.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { ENV } from "@invisible-dots/shared";
import { QemuNotFoundError, SETUP_COMMAND } from "./errors.js";

export type Accelerator = "kvm" | "whpx";

/**
 * The QEMU accelerator of this host (section 1.1): KVM on Linux, the Windows
 * Hypervisor Platform on Windows. Any other host is unsupported rather than
 * given software emulation, which the contract never uses.
 */
export function accelerator(platform: NodeJS.Platform = process.platform): Accelerator {
  switch (platform) {
    case "linux":
      return "kvm";
    case "win32":
      return "whpx";
    default:
      throw new Error(
        `invisible_dots does not run on ${platform}: it needs Linux (KVM) or Windows (Windows Hypervisor Platform) on x86-64 ` +
          `(architecture section 1.1). Run "${SETUP_COMMAND}" on a supported host.`,
      );
  }
}

/**
 * The official Windows installer installs into `$PROGRAMFILES64\qemu` (its
 * InstallDir). virtualization/qemu/windows.json records the same
 * subdirectory and a test keeps the two equal.
 */
export const OFFICIAL_QEMU_SUBDIR = "qemu";

/**
 * Where the official Windows installer puts QEMU on this host by default:
 * `%ProgramW6432%\qemu` (`%ProgramFiles%\qemu` for a 64-bit process, which
 * Node is), so a Program Files on another drive is found too. Read from the
 * variables Windows sets, which Linux does not have: there is no such
 * directory there and nothing to check the platform for.
 */
export function officialQemuDir(env: Record<string, string | undefined> = process.env): string | undefined {
  const programFiles = (env.ProgramW6432 ?? env.PROGRAMW6432 ?? env.ProgramFiles ?? env.PROGRAMFILES)?.trim();
  return programFiles ? join(programFiles, OFFICIAL_QEMU_SUBDIR) : undefined;
}

/**
 * Executable names tried in every directory. Windows executables carry
 * ".exe" and Linux ones do not; trying both everywhere keeps the search
 * identical on both hosts.
 */
export const QEMU_SYSTEM_NAMES = ["qemu-system-x86_64", "qemu-system-x86_64.exe"] as const;
export const QEMU_IMG_NAMES = ["qemu-img", "qemu-img.exe"] as const;

/**
 * The directories searched for QEMU, in the order of section 3.1: when
 * INVISIBLE_DOTS_QEMU_DIR is set, that directory alone (mixing a configured
 * QEMU with another one would run a qemu-img of a different version on the
 * same disks); otherwise the official installer's directory, then every
 * PATH entry. The installer's directory comes first so the QEMU that `setup`
 * just installed wins over an older one somewhere on PATH. Relative entries
 * are dropped, because QEMU is always invoked by absolute path.
 */
export function qemuSearchDirs(env: Record<string, string | undefined> = process.env): string[] {
  const configured = env[ENV.QEMU_DIR]?.trim();
  if (configured) return [configured];
  const dirs: string[] = [];
  const official = officialQemuDir(env);
  if (official) dirs.push(official);
  // Windows spells the variable "Path"; Node's process.env hides that, a plain object does not.
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const entry of pathValue.split(delimiter)) {
    // cmd.exe users sometimes quote PATH entries that contain spaces.
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (dir) dirs.push(dir);
  }
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    if (!isAbsolute(dir) || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

export interface QemuInstallation {
  /** Absolute path of qemu-system-x86_64. */
  system: string;
  /** Absolute path of qemu-img. */
  img: string;
}

/** Whether `path` is a file this user may execute. Doctor's own search uses it too. */
export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    // X_OK is checked as existence on Windows, where executability is the extension.
    await access(path, constants.X_OK);
    // A directory passes X_OK on Linux; it is not a program.
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findIn(dirs: readonly string[], names: readonly string[], exists: (path: string) => Promise<boolean>): Promise<string | undefined> {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Find qemu-system-x86_64 and qemu-img in the directories of `qemuSearchDirs`. */
export async function findQemu(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => Promise<boolean> = isExecutableFile,
): Promise<QemuInstallation> {
  const configured = env[ENV.QEMU_DIR]?.trim();
  const dirs = qemuSearchDirs(env);
  if (configured && !isAbsolute(configured)) {
    throw new QemuNotFoundError(`qemu-system-x86_64 (${ENV.QEMU_DIR}="${configured}" is not an absolute path)`, []);
  }
  const system = await findIn(dirs, QEMU_SYSTEM_NAMES, exists);
  if (!system) throw new QemuNotFoundError("qemu-system-x86_64", dirs);
  const img = await findIn(dirs, QEMU_IMG_NAMES, exists);
  if (!img) throw new QemuNotFoundError("qemu-img", dirs);
  return { system, img };
}

/**
 * The oldest QEMU the contract supports (section 3.1): 8.2, the version
 * Ubuntu 24.04 packages, measured with the argv of section 3.4 and doctor's
 * probe. This is the one place the number lives; messages use the text below.
 */
export const MIN_QEMU_VERSION = { major: 8, minor: 2 } as const;
export const MIN_QEMU_VERSION_TEXT = `${MIN_QEMU_VERSION.major}.${MIN_QEMU_VERSION.minor}`;

export interface QemuVersion {
  major: number;
  minor: number;
  micro: number;
}

/** Parse `qemu-system-x86_64 --version` or `qemu-img --version` output. */
export function parseQemuVersion(output: string): QemuVersion | undefined {
  const match = /version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), micro: Number(match[3] ?? 0) };
}

export function isSupportedQemuVersion(version: QemuVersion): boolean {
  return version.major > MIN_QEMU_VERSION.major || (version.major === MIN_QEMU_VERSION.major && version.minor >= MIN_QEMU_VERSION.minor);
}
