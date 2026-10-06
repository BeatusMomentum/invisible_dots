/**
 * The host report (architecture section 11.1): every check, in the
 * contract's order, each answering ok / missing / failed and naming the
 * command that fixes it. It runs in the API process (`GET /api/doctor`) and
 * in `invisible-dots doctor` alike. Doctor only reads: it never creates a
 * directory, never opens the database and never changes a setting.
 *
 * Status meanings, so every check uses them the same way (`DoctorStatus`):
 * - ok: present and working.
 * - missing: absent; the fix line installs or creates it.
 * - failed: present but not working, or the check itself could not tell.
 */
import { ENV, type DoctorAnswer, type DoctorCheck, type DoctorCheckId, type DoctorStatus } from "@invisible-dots/shared";
import { SETUP_COMMAND, STORE_OPENROUTER_KEY } from "./errors.js";
import { isSupportedQemuVersion, MIN_QEMU_VERSION_TEXT, parseQemuVersion, type Accelerator, type QemuVersion } from "./host.js";
import { qemuPathProblem } from "./qemu-args.js";
import { firstLine, type RunOptions, type RunResult } from "./runner.js";

/** Where the QEMU programs were found, each searched separately (section 3.1). */
export interface FoundQemu {
  system?: string;
  img?: string;
  /** The places searched, in order, for the message when something is not found. */
  searched: string[];
  /** INVISIBLE_DOTS_QEMU_DIR is set, so it was the only place searched. */
  configured?: boolean;
}

export type Runner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

export interface DoctorDeps {
  /** `process.versions.node`. */
  nodeVersion: string;
  /** The vm-manager's choice for this host (section 1.1); throws on a host invisible_dots does not run on. */
  accelerator(): Accelerator;
  findQemu(): Promise<FoundQemu>;
  run: Runner;
  /** The host side of the accelerator: /dev/kvm or the HypervisorPlatform feature (accelerator-access.ts). */
  acceleratorAccess(): Promise<DoctorCheck>;
  /** INVISIBLE_DOTS_HOME, as the server and the image builder will use it. */
  home: string;
  /** Free space for INVISIBLE_DOTS_HOME, measured on the nearest directory that exists. */
  freeSpace(): Promise<{ path: string; bytes: number }>;
  /** The golden image and the runtime ISO against their manifests, one result each. */
  images(): Promise<DoctorCheck[]>;
  /** Whether an OpenRouter key is stored. */
  openRouterKey(): Promise<DoctorCheck>;
}

export const MIN_NODE_MAJOR = 24;
/**
 * One golden image (a few GiB once provisioned) plus the overlays of a few
 * Dots, which grow with what each Dot stores. Below this a first `image
 * build` or a busy Dot runs the disk full.
 */
export const MIN_FREE_BYTES = 20 * 1024 ** 3;
/**
 * The probe boots the empty machine's firmware, which takes a fraction of a
 * second with a working accelerator (0.2 s measured with QEMU 8.2 and KVM);
 * a QEMU still running after this long has a virtual CPU that does not run.
 */
export const PROBE_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 15_000;

/**
 * Starts QEMU with the accelerator and the CPU model of the Dots (section
 * 3.4) on their machine type with no devices at all, and lets the virtual
 * CPU run: the firmware finds nothing to boot, `-boot reboot-timeout=0`
 * makes it reset at once, and `-no-reboot` turns that reset into QEMU
 * exiting with code 0. So exit code 0 means the accelerator opened AND ran
 * guest code, which a QEMU held before its first instruction could never
 * show; there is no monitor to talk to, the same as for a Dot. `-accel` is
 * given alone, so QEMU cannot fall back to software emulation.
 *
 * Measured with QEMU 8.2.2 and KVM: exit 0 after 0.2 s, and the firmware's
 * debug output reads "No bootable device. Retrying in 0 seconds. Rebooting."
 * Without `-no-reboot`, or without the reboot timeout, QEMU never exits.
 *
 * Not `-machine none`: measured with QEMU 11.1 on Windows, WHPX with
 * `-machine none` aborts with "X86_MACHINE: Object ... is not an instance of
 * type x86-machine" (exit 3) even where WHPX works, and it has no CPU to run.
 */
export function acceleratorProbeArgs(accelerator: Accelerator): string[] {
  return [
    "-nodefaults",
    "-no-user-config",
    "-machine",
    "q35",
    "-accel",
    accelerator,
    "-cpu",
    "host",
    "-display",
    "none",
    "-no-reboot",
    "-boot",
    "reboot-timeout=0",
  ];
}

/**
 * PATH alone can hold dozens of directories, so the line names the search
 * order of section 3.1 and how many places it covered rather than all of them.
 */
function notFound(found: FoundQemu): string {
  const count = found.searched.length;
  if (count === 1 && found.searched[0]!.startsWith("(")) return `not found ${found.searched[0]}`;
  if (found.configured) return `not found in ${ENV.QEMU_DIR} (${found.searched[0] ?? ""}), the only place searched while it is set`;
  return `not found in the official installer's directory or on PATH (${count} ${count === 1 ? "directory" : "directories"} searched)`;
}

function versionText(version: QemuVersion): string {
  return `${version.major}.${version.minor}.${version.micro}`;
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function result(id: DoctorCheckId, label: string, status: DoctorStatus, detail: string, fix?: string): DoctorCheck {
  return fix === undefined || status === "ok" ? { id, label, status, detail } : { id, label, status, detail, fix };
}

export function checkNode(version: string): DoctorCheck {
  const major = Number(version.split(".")[0]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return result("node", "Node", "ok", version);
  return result("node", "Node", "failed", `${version} is older than ${MIN_NODE_MAJOR}`, `install Node ${MIN_NODE_MAJOR} or newer from https://nodejs.org`);
}

async function checkQemuSystem(found: FoundQemu, run: Runner): Promise<DoctorCheck> {
  const label = "QEMU";
  const minimum = MIN_QEMU_VERSION_TEXT;
  if (!found.system) {
    return result("qemu", label, "missing", `qemu-system-x86_64 ${notFound(found)}`, SETUP_COMMAND);
  }
  const answer = await run(found.system, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  const version = answer.code === 0 ? parseQemuVersion(answer.stdout) : undefined;
  if (!version) {
    const why = answer.startError?.message ?? (firstLine(answer.stderr) || `exit code ${answer.code}`);
    return result("qemu", label, "failed", `${found.system} --version did not report a version (${why})`, SETUP_COMMAND);
  }
  const text = versionText(version);
  if (!isSupportedQemuVersion(version)) {
    return result(
      "qemu",
      label,
      "failed",
      `${found.system} is version ${text}, older than ${minimum}`,
      `${SETUP_COMMAND}, or set INVISIBLE_DOTS_QEMU_DIR to a QEMU ${minimum} or newer`,
    );
  }
  return result("qemu", label, "ok", `${text} at ${found.system}`);
}

async function checkQemuImg(found: FoundQemu, run: Runner): Promise<DoctorCheck> {
  if (!found.img) return result("qemu-img", "qemu-img", "missing", `qemu-img ${notFound(found)}`, SETUP_COMMAND);
  const answer = await run(found.img, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  const version = answer.code === 0 ? parseQemuVersion(answer.stdout) : undefined;
  if (!version) {
    const why = answer.startError?.message ?? (firstLine(answer.stderr) || `exit code ${answer.code}`);
    return result("qemu-img", "qemu-img", "failed", `${found.img} --version did not report a version (${why})`, SETUP_COMMAND);
  }
  return result("qemu-img", "qemu-img", "ok", `${versionText(version)} at ${found.img}`);
}

/**
 * Runs whenever QEMU is ready, also when the host-side check said the
 * accelerator is missing: that check reads a precondition, the probe reads
 * the result. Measured on Windows 11 with VirtualMachinePlatform enabled
 * (WSL 2): HypervisorPlatform reports disabled and WHPX still works.
 */
async function probeAccelerator(deps: DoctorDeps, qemu: DoctorCheck, access: DoctorCheck, system: string | undefined): Promise<DoctorCheck> {
  const label = "accelerator probe";
  if (qemu.status !== "ok" || !system) {
    return result("accelerator-probe", label, qemu.status, `not run: QEMU is not ready`, qemu.fix);
  }
  const accelerator = deps.accelerator();
  const command = `qemu-system-x86_64 -accel ${accelerator} -cpu host -machine q35`;
  const answer = await deps.run(system, acceleratorProbeArgs(accelerator), { timeoutMs: PROBE_TIMEOUT_MS });
  if (answer.code === 0 && !answer.timedOut) return result("accelerator-probe", label, "ok", `${command} ran the firmware and exited`);
  const why = answer.timedOut
    ? `did not exit within ${PROBE_TIMEOUT_MS / 1000} s, so the virtual CPU does not run${firstLine(answer.stderr) ? ` (QEMU said: ${firstLine(answer.stderr)})` : ""}`
    : (answer.startError?.message ?? (firstLine(answer.stderr) || `exit code ${answer.code}`));
  const fix =
    access.status !== "ok" && access.fix
      ? access.fix
      : "enable hardware virtualization (Intel VT-x or AMD-V) in the firmware settings; after enabling the accelerator, restart the computer";
  return result("accelerator-probe", label, "failed", `${command} failed: ${why}`, fix);
}

/** A host-side "missing" that the probe contradicts is reported as what it is: QEMU uses the accelerator. */
function confirmedByProbe(access: DoctorCheck, probe: DoctorCheck): DoctorCheck {
  if (access.status !== "missing" || probe.status !== "ok") return access;
  return result("accelerator", access.label, "ok", `${access.detail}, but the probe below shows QEMU uses the accelerator`);
}

const DATA_DIRECTORY = "data directory";

/**
 * INVISIBLE_DOTS_HOME: a path QEMU can be given (the same rule a Dot's start
 * applies, qemuPathProblem), with enough free space. A home under an account
 * name with an accent fails here, before an image build or a Dot does.
 */
export function checkDataDirectory(home: string, space: { path: string; bytes: number }): DoctorCheck {
  const problem = qemuPathProblem(home);
  if (problem) {
    return result("disk", DATA_DIRECTORY, "failed", `${home} ${problem}`, `set ${ENV.HOME} to a directory whose path is plain ASCII without commas`);
  }
  const detail = `${formatBytes(space.bytes)} free at ${space.path}`;
  if (space.bytes >= MIN_FREE_BYTES) return result("disk", DATA_DIRECTORY, "ok", detail);
  return result(
    "disk",
    DATA_DIRECTORY,
    "failed",
    `${detail}, less than ${formatBytes(MIN_FREE_BYTES)}`,
    `free some space, or set ${ENV.HOME} to a directory on a larger disk`,
  );
}

/** Runs one check; a check that throws is reported as failed instead of ending the report. */
async function guarded(id: DoctorCheckId, label: string, check: () => Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await check();
  } catch (error) {
    return result(id, label, "failed", `the check itself failed: ${(error as Error).message}`);
  }
}

/** Every check of section 11.1, in its order. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const results: DoctorCheck[] = [checkNode(deps.nodeVersion)];
  let found: FoundQemu = { searched: [] };
  try {
    found = await deps.findQemu();
  } catch (error) {
    found = { searched: [`(the search failed: ${(error as Error).message})`] };
  }
  const qemu = await guarded("qemu", "QEMU", () => checkQemuSystem(found, deps.run));
  results.push(qemu);
  results.push(await guarded("qemu-img", "qemu-img", () => checkQemuImg(found, deps.run)));
  const access = await guarded("accelerator", "accelerator", () => deps.acceleratorAccess());
  const probe = await guarded("accelerator-probe", "accelerator probe", () => probeAccelerator(deps, qemu, access, found.system));
  results.push(confirmedByProbe(access, probe), probe);
  results.push(await guarded("disk", DATA_DIRECTORY, async () => checkDataDirectory(deps.home, await deps.freeSpace())));
  try {
    results.push(...(await deps.images()));
  } catch (error) {
    const detail = `the check itself failed: ${(error as Error).message}`;
    results.push(result("golden-image", "golden image", "failed", detail), result("runtime-image", "runtime ISO", "failed", detail));
  }
  results.push(await guarded("openrouter", "OpenRouter key", () => deps.openRouterKey()));
  return results;
}

export function allOk(results: readonly DoctorCheck[]): boolean {
  return results.every((r) => r.status === "ok");
}

/** The report as the API and `doctor --json` send it. */
export function doctorAnswer(results: readonly DoctorCheck[]): DoctorAnswer {
  return { ok: allOk(results), checks: [...results] };
}

/**
 * The OpenRouter key row from what the control plane knows (`openrouter_configured` of its health), asked of
 * the scheduler in the API and of the running server by the CLI.
 */
export function openRouterCheck(configured: boolean): DoctorCheck {
  const base = { id: "openrouter", label: "OpenRouter key" } as const;
  return configured ? { ...base, status: "ok", detail: "stored" } : { ...base, status: "missing", detail: "no key stored", fix: STORE_OPENROUTER_KEY };
}
