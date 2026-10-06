/**
 * The CLI's platform split (architecture section 1.1), and the only place in
 * apps/cli that asks which operating system it runs on: how QEMU and the
 * accelerator are installed, the distribution's package with sudo on Linux,
 * one UAC prompt on Windows that enables the HypervisorPlatform feature and
 * runs the official QEMU installer silently. How the accelerator is READ
 * (/dev/kvm, the feature state) is the vm-manager's `checkAcceleratorAccess`,
 * which the API's doctor route runs too.
 *
 * Everything else `setup` and `doctor` do is the same code on both hosts.
 */
// The Windows branch builds Windows paths whatever host the tests run on.
import { win32 } from "node:path";
import { ENV } from "@invisible-dots/shared";
import {
  checkKvmDevice,
  firstLine,
  HYPERVISOR_PLATFORM_FEATURE,
  MIN_QEMU_VERSION_TEXT,
  officialQemuDir,
  powershellArgs,
  powershellPath,
  UNSUPPORTED_FIX,
  type AccessDeps,
} from "@invisible-dots/vm-manager";
import {
  ELEVATED_RESULT_FILE,
  elevatedSetupScript,
  type ElevatedScriptOptions,
  elevationLauncherScript,
  parseElevatedResult,
  RESTART_REQUIRED_EXIT_CODE,
  UNSAFE_WORK_DIR_EXIT_CODE,
} from "./powershell.js";
import { installerFileName, type WindowsQemuPin } from "./qemu-pin.js";

export const APT_PACKAGES = ["qemu-system-x86", "qemu-utils"] as const;

/** The UAC prompt waits for a person, and the installer copies a few hundred MiB. */
const ELEVATED_TIMEOUT_MS = 60 * 60 * 1000;

export interface InstallDeps extends AccessDeps {
  log(line: string): void;
  readText(path: string): Promise<string>;
  /** Linux: whether setup runs as root (see `currentUserIsRoot`), which it refuses. */
  isRoot: boolean;
  /** Windows: the pinned installer, read only when QEMU has to be installed. */
  windowsQemuPin(): WindowsQemuPin;
  makeTempDir(): Promise<string>;
  removeDir(path: string): Promise<void>;
  /** Downloads `pin.url` to `dest` as the normal user and rejects unless it hashes to `pin.sha256`. */
  download(pin: WindowsQemuPin, dest: string): Promise<void>;
  /** Windows: the security identifier of the user running setup. */
  userSid(): Promise<string>;
  /** A name no one can guess, for the elevated session's own directory. */
  uniqueName(): string;
}

/**
 * Whether this process runs as root. getuid exists only on POSIX hosts, so
 * on Windows the answer is false: there setup never runs as an
 * administrator, it asks for one prompt instead.
 */
export function currentUserIsRoot(): boolean {
  return process.getuid?.() === 0;
}

/**
 * Why setup must not go on, or null. As root on Linux it would check
 * /dev/kvm for root instead of for the person who runs the server, report
 * the accelerator ready, and that person's first Dot would then fail;
 * setup calls sudo itself for the one step that needs it, as Windows asks
 * for one prompt.
 */
export function setupRefusal(deps: Pick<InstallDeps, "platform" | "isRoot">): string | null {
  if (deps.platform === "linux" && deps.isRoot) {
    return "run invisible-dots setup as the user who runs the server, not as root: it calls sudo itself for the step that needs it";
  }
  return null;
}

export interface InstallRequest {
  /** qemu-system-x86_64 or qemu-img is missing or too old. */
  installQemu: boolean;
  /** The accelerator check answered `missing`. */
  enableAccelerator: boolean;
}

export type InstallOutcome =
  /** Installed; doctor should now see QEMU and the accelerator. */
  | { kind: "done"; lines: string[] }
  /** Installed, but Windows must restart before the accelerator works. */
  | { kind: "restart"; lines: string[] }
  /** The person has to run something setup does not run itself. */
  | { kind: "manual"; lines: string[] }
  | { kind: "failed"; lines: string[] };

/** Installs what doctor found missing, the way this host installs things. */
export async function installHostPrerequisites(request: InstallRequest, deps: InstallDeps): Promise<InstallOutcome> {
  if (deps.platform === "linux") return installOnLinux(request, deps);
  if (deps.platform === "win32") return installOnWindows(request, deps);
  return { kind: "failed", lines: [`${deps.platform} hosts are not supported: ${UNSUPPORTED_FIX}`] };
}

// Linux

export interface OsRelease {
  id: string;
  idLike: string[];
  prettyName?: string;
}

/** /etc/os-release, the fields that say which package manager the distribution uses. */
export function parseOsRelease(text: string): OsRelease {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) fields[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return {
    id: (fields.ID ?? "").toLowerCase(),
    idLike: (fields.ID_LIKE ?? "").toLowerCase().split(/\s+/).filter(Boolean),
    ...(fields.PRETTY_NAME ? { prettyName: fields.PRETTY_NAME } : {}),
  };
}

export type PackageManager = { kind: "apt" } | { kind: "print"; line: string };

/**
 * apt is run; other package managers only get their line printed, because a
 * wrong package name on a distribution nobody tested would install the wrong
 * thing with root rights.
 */
export function packageManagerFor(os: OsRelease): PackageManager {
  const family = [os.id, ...os.idLike];
  if (family.some((id) => id === "debian" || id === "ubuntu")) return { kind: "apt" };
  if (family.some((id) => id === "fedora" || id === "rhel" || id === "centos")) {
    return { kind: "print", line: "sudo dnf install -y qemu-system-x86 qemu-img" };
  }
  if (family.includes("arch")) return { kind: "print", line: "sudo pacman -S --needed qemu-system-x86 qemu-img" };
  return { kind: "print", line: `install qemu-system-x86_64 and qemu-img (QEMU ${MIN_QEMU_VERSION_TEXT} or newer) with your distribution's package manager` };
}

async function installOnLinux(request: InstallRequest, deps: InstallDeps): Promise<InstallOutcome> {
  const manual: string[] = [];
  if (request.installQemu) {
    const os = parseOsRelease(await deps.readText("/etc/os-release").catch(() => ""));
    const manager = packageManagerFor(os);
    if (manager.kind === "apt") {
      // Never run as root (setupRefusal), so sudo is always the way to the one root step.
      const argv = ["sudo", "apt-get", "install", "-y", ...APT_PACKAGES];
      deps.log(`$ ${argv.join(" ")}`);
      const answer = await deps.run(argv[0]!, argv.slice(1), { inheritStdio: true });
      if (answer.code !== 0) {
        const why = answer.startError?.message ?? `exit code ${answer.code ?? answer.signal}`;
        return { kind: "failed", lines: [`${argv.join(" ")} failed (${why})`] };
      }
    } else {
      manual.push(`QEMU is not installed by setup on ${os.prettyName ?? (os.id || "this distribution")}; run:`, `  ${manager.line}`);
    }
  }

  const access = await checkKvmDevice(deps);
  if (access.status !== "ok") manual.push(`${access.detail}; fix:`, `  ${access.fix}`);
  return manual.length > 0 ? { kind: "manual", lines: manual } : { kind: "done", lines: [] };
}

// Windows

async function installOnWindows(request: InstallRequest, deps: InstallDeps): Promise<InstallOutcome> {
  if (!request.installQemu && !request.enableAccelerator) return { kind: "done", lines: [] };
  const work = await deps.makeTempDir();
  // The elevated session's own directory; it checks this is directly under the real ProgramData.
  const programData = deps.env.ProgramData ?? deps.env.PROGRAMDATA ?? "C:\\ProgramData";
  const elevatedDir = win32.join(programData, `invisible-dots-setup-${deps.uniqueName()}`);
  try {
    let installer: ElevatedScriptOptions["installer"];
    if (request.installQemu) {
      const pin = deps.windowsQemuPin();
      const path = win32.join(work, installerFileName(pin));
      deps.log(`downloading the official QEMU ${pin.version} installer: ${pin.url}`);
      await deps.download(pin, path);
      deps.log(`verified its SHA-256 (${pin.sha256})`);
      installer = { path, sha256: pin.sha256, silentArgs: pin.silentArgs };
    }

    const userSid = await deps.userSid();
    const steps = [
      ...(request.enableAccelerator ? [`enable the ${HYPERVISOR_PLATFORM_FEATURE} feature (dism)`] : []),
      ...(installer ? ["run the QEMU installer silently"] : []),
    ];
    deps.log(`asking for administrator rights once, to ${steps.join(" and ")}`);
    const elevated = elevatedSetupScript({
      enableHypervisorPlatform: request.enableAccelerator,
      ...(installer ? { installer } : {}),
      workDir: elevatedDir,
      userSid,
    });
    const powershell = powershellPath(deps.env);
    const launch = await deps.run(powershell, powershellArgs(elevationLauncherScript(powershell, elevated)), { timeoutMs: ELEVATED_TIMEOUT_MS });

    const text = await deps.readText(win32.join(elevatedDir, ELEVATED_RESULT_FILE)).catch(() => undefined);
    if (text === undefined) {
      if (launch.code === UNSAFE_WORK_DIR_EXIT_CODE) {
        return {
          kind: "failed",
          lines: [`the elevated step could not create its own directory ${elevatedDir} for administrators only, so it ran nothing; run setup again`],
        };
      }
      const why = firstLine(launch.stderr) || (launch.timedOut ? "it did not finish within an hour" : `exit code ${launch.code}`);
      const declined = /cancel/i.test(launch.stderr);
      return {
        kind: "failed",
        lines: [
          declined
            ? "administrator rights were not granted (the prompt was declined); nothing was changed"
            : `the elevated step did not report back: ${why}`,
        ],
      };
    }
    return interpretElevatedResult(text, deps.env);
  } finally {
    await deps.removeDir(elevatedDir).catch(() => undefined);
    await deps.removeDir(work).catch(() => undefined);
  }
}

/** What the elevated session's result file means for the person. */
export function interpretElevatedResult(text: string, env: Record<string, string | undefined> = {}): InstallOutcome {
  let result;
  try {
    result = parseElevatedResult(text);
  } catch (error) {
    return { kind: "failed", lines: [`the elevated step wrote an unreadable result: ${(error as Error).message}`] };
  }
  if (result.error) return { kind: "failed", lines: [`the elevated step failed: ${result.error}`] };
  const lines: string[] = [];
  if (result.installer_exit_code === 0) {
    lines.push("QEMU installed");
    // The installer reuses the directory of an earlier QEMU, which may be one invisible-dots does not search.
    const official = officialQemuDir(env);
    // Windows paths compared as Windows does: either separator, any case, no trailing one.
    const trim = (dir: string) => dir.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
    if (result.install_dir && (!official || trim(result.install_dir) !== trim(official))) {
      lines.push(`it went to ${result.install_dir}, where an earlier QEMU was installed: set ${ENV.QEMU_DIR}=${result.install_dir} so invisible-dots uses it`);
    }
  }
  if (result.dism_exit_code === RESTART_REQUIRED_EXIT_CODE) {
    lines.push(
      `the ${HYPERVISOR_PLATFORM_FEATURE} feature is enabled; Windows must restart before it works`,
      "restart Windows, then run: invisible-dots doctor",
    );
    return { kind: "restart", lines };
  }
  if (result.dism_exit_code === 0) lines.push(`the ${HYPERVISOR_PLATFORM_FEATURE} feature is enabled`);
  return { kind: "done", lines };
}
