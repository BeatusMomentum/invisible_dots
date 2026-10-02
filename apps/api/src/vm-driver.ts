/**
 * The real ComputerDriver: an adapter over vm-manager's VmManager. It adds
 * the one decision VmManager leaves to its caller, which images a computer
 * uses:
 *
 * - a new computer gets the newest `golden-<version>.qcow2`; its overlay
 *   stays on that golden image for its whole life (a backing file never
 *   changes under a disk);
 * - every start uses the newest `runtime-<version>.iso`, so a new version of
 *   our code reaches a Dot with a restart (section 3.3).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ComputerDriver,
  ComputerSpecInput,
  CreatedComputer,
  DomainState,
  GuestApi,
  StartedComputer,
} from "@invisible-dots/scheduler";
import { type ComputerSpec, type VmManager } from "@invisible-dots/vm-manager";

const GOLDEN = /^golden-(.+)\.qcow2$/;
const RUNTIME = /^runtime-(.+)\.iso$/;

/** Compare versions such as "2026.10.1" and "2026.9.3" numerically, part by part. */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/** The file of `dir` with the highest version for `pattern`, as an absolute path. */
export async function latestImage(dir: string, pattern: RegExp, label: string): Promise<string> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw new Error(`cannot list the images directory ${dir}: ${(error as Error).message}`, { cause: error });
  }
  const candidates = names
    .map((name) => ({ name, version: pattern.exec(name)?.[1] }))
    .filter((c): c is { name: string; version: string } => c.version !== undefined)
    .sort((x, y) => compareVersions(x.version, y.version));
  const newest = candidates.at(-1);
  if (!newest) {
    throw new Error(`no ${label} in ${dir}: build one with guest/image-builder (expected a file like ${label === "golden image" ? "golden-<version>.qcow2" : "runtime-<version>.iso"})`);
  }
  return join(dir, newest.name);
}

export class VmManagerDriver implements ComputerDriver {
  readonly #vm: VmManager;
  readonly #imagesDir: string;

  constructor(vm: VmManager, options: { imagesDir?: string } = {}) {
    this.#vm = vm;
    this.#imagesDir = options.imagesDir ?? vm.paths.imagesDir;
  }

  latestGolden(): Promise<string> {
    return latestImage(this.#imagesDir, GOLDEN, "golden image");
  }

  latestRuntime(): Promise<string> {
    return latestImage(this.#imagesDir, RUNTIME, "runtime ISO");
  }

  #spec(input: ComputerSpecInput, goldenImage: string, runtimeImage: string): ComputerSpec {
    return {
      dotId: input.dotId,
      cid: input.cid,
      token: input.token,
      goldenImage,
      runtimeImage,
      cpus: input.resources.cpus,
      memoryMiB: input.resources.memoryMiB,
      diskBytes: input.resources.diskBytes,
    };
  }

  async create(input: ComputerSpecInput): Promise<CreatedComputer> {
    const [golden, runtime] = await Promise.all([this.latestGolden(), this.latestRuntime()]);
    const created = await this.#vm.createVM(this.#spec(input, golden, runtime));
    return { domainName: created.domainName, goldenImage: golden, runtimeImage: runtime };
  }

  async start(input: ComputerSpecInput & { goldenImage: string }, reservedCids: readonly number[]): Promise<StartedComputer> {
    const runtime = await this.latestRuntime();
    const state = await this.#vm.getVMState(input.dotId);
    // A bigger computer.disk from a PATCH: the overlay can only grow while the VM is off.
    if (state.defined && state.libvirt === "shut off") {
      await this.#vm.resizeDisk(input.dotId, input.resources.diskBytes);
    }
    const started = await this.#vm.startVM(this.#spec(input, input.goldenImage, runtime), { reservedCids });
    return { cid: started.cid, runtimeImage: runtime, alreadyRunning: started.alreadyRunning };
  }

  async stop(dotId: string): Promise<{ forced: boolean }> {
    return this.#vm.stopVM(dotId);
  }

  reboot(dotId: string): Promise<void> {
    return this.#vm.rebootVM(dotId);
  }

  destroy(dotId: string): Promise<void> {
    return this.#vm.destroyVM(dotId);
  }

  async state(dotId: string): Promise<DomainState> {
    const info = await this.#vm.getVMState(dotId);
    return { defined: info.defined, state: info.state, detail: info.libvirt };
  }

  async attach(dotId: string, cid: number): Promise<void> {
    await this.#vm.ensureBridge(dotId, cid);
  }

  guest(dotId: string, token: string): GuestApi {
    return this.#vm.guestClient(dotId, token);
  }

  close(): Promise<void> {
    return this.#vm.stopAllBridges();
  }
}
