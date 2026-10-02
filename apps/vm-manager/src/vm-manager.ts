/**
 * The libvirt driver (architecture sections 3, 9.4, 9.5). It is stateless
 * apart from the bridge processes it runs: the control plane stores the CID,
 * the token and the image versions in `computers` and passes them in as a
 * ComputerSpec on every call that needs them.
 */
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import {
  computerResources,
  domainName,
  hostPaths,
  type DotConfig,
  type HostPaths,
  type VmState,
} from "@invisible-dots/shared";
import { VsockBridge, type BridgeOptions } from "./bridge.js";
import { allocateCid, cidBaseFromEnv, isCidInUseError } from "./cid.js";
import { CommandError, NotImplementedError, VmManagerError, VmStateError } from "./errors.js";
import { GuestClient, type GuestClientOptions } from "./guest-client.js";
import { stderrLogger, type Logger } from "./logger.js";
import { ExecFileRunner, type CommandRunner } from "./runner.js";
import { loadTemplates, renderDomainXml, renderSeed, type TemplateSet } from "./templates.js";

/** Everything the vm-manager needs to know about one Dot's computer. */
export interface ComputerSpec {
  dotId: string;
  /** vsock CID, as recorded in `computers.cid`. */
  cid: number;
  /** The Dot token, in clear (the control plane decrypts `token_enc`). */
  token: string;
  /** Absolute path of the golden image the overlay is backed by. */
  goldenImage: string;
  /** Absolute path of the runtime ISO. */
  runtimeImage: string;
  cpus: number;
  memoryMiB: number;
  diskBytes: number;
}

/** Build a ComputerSpec from a parsed Dot config plus what the control plane stored. */
export function computerSpecFromConfig(
  dotId: string,
  config: Pick<DotConfig, "computer">,
  stored: { cid: number; token: string; goldenImage: string; runtimeImage: string },
): ComputerSpec {
  const resources = computerResources(config);
  return {
    dotId,
    ...stored,
    cpus: resources.cpus,
    memoryMiB: resources.memoryMiB,
    diskBytes: resources.diskBytes,
  };
}

/** A new Dot token: 32 random bytes, base64url. It only authorizes requests to that Dot's VM. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What `virsh domstate` prints, mapped to the VM states of section 9.3. */
export function mapDomState(libvirtState: string): VmState {
  switch (libvirtState.trim().toLowerCase()) {
    case "running":
    case "idle":
    case "blocked":
      return "RUNNING";
    case "in shutdown":
      return "STOPPING";
    case "shut off":
      return "STOPPED";
    // We never pause or suspend a Dot. libvirt pauses a domain on its own when
    // the disk fills up or an I/O error happens, so these mean something broke.
    case "paused":
    case "pmsuspended":
    case "crashed":
    case "no state":
    default:
      return "ERROR";
  }
}

export interface VmStateInfo {
  /** Whether libvirt knows the domain at all. */
  defined: boolean;
  state: VmState;
  /** The raw `virsh domstate` text, null when the domain is not defined. */
  libvirt: string | null;
}

export interface VmManagerOptions {
  runner?: CommandRunner;
  /** Environment for INVISIBLE_DOTS_* settings. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Host paths; default from `hostPaths(env)`. */
  paths?: HostPaths;
  /** libvirt connection. Default LIBVIRT_DEFAULT_URI from env, else qemu:///system. */
  libvirtUri?: string;
  logger?: Logger;
  /** Where the templates live. Default the repository's `virtualization/`. */
  virtualizationDir?: string;
  /** Graceful shutdown budget before `virsh destroy` (section 9.5). Default 60 s. */
  shutdownTimeoutMs?: number;
  /** How often domstate is polled while waiting for a shutdown. Default 1 s. */
  pollIntervalMs?: number;
  /** How many CIDs `startVM` tries when the kernel says one is in use. Default 16. */
  maxCidAttempts?: number;
  /** Bridge tuning; the socket path comes from `bridgeSocketPath`. */
  bridge?: Pick<BridgeOptions, "socatCommand" | "readyTimeoutMs" | "restartDelayMs" | "socketExists">;
  /** Override of the bridge socket path (tests on Windows use named pipes). */
  bridgeSocketPath?: (dotId: string) => string;
  /** Timeouts of host commands. */
  timeouts?: { virshMs?: number; qemuImgMs?: number; isoMs?: number };
  sleep?: (ms: number) => Promise<void>;
}

export interface CreateVmResult {
  domainName: string;
  vmDir: string;
  diskPath: string;
  seedPath: string;
  xmlPath: string;
  /** False when the overlay already existed and was kept (a retried create never wipes a disk). */
  diskCreated: boolean;
}

export interface StartVmOptions {
  /** CIDs other Dots hold according to the `computers` table. */
  reservedCids?: Iterable<number>;
}

export interface StartVmResult {
  /** The CID the VM runs with. Store it when it differs from `spec.cid`. */
  cid: number;
  cidChanged: boolean;
  alreadyRunning: boolean;
}

export interface StopVmResult {
  /** True when the guest did not power off in time and was destroyed. */
  forced: boolean;
}

export interface ResizeResult {
  /** True when the VM is running and the new size applies from its next start. */
  restartRequired: boolean;
}

const DOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertDotId(dotId: string): void {
  if (!DOT_ID_PATTERN.test(dotId)) {
    throw new VmManagerError(`invalid dot id "${dotId}": expected lowercase letters, digits, "_" and "-", at most 64 characters`);
  }
}

function assertIntInRange(label: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new VmManagerError(`${label} must be an integer from ${min} to ${max}, got ${value}`);
  }
}

function isDomainMissing(error: unknown): boolean {
  return error instanceof CommandError && /failed to get domain|domain not found|no domain with matching/i.test(error.stderr);
}

function isNotRunning(error: unknown): boolean {
  return error instanceof CommandError && /not running|domain is not running/i.test(error.stderr);
}

export class VmManager {
  readonly paths: HostPaths;
  private readonly runner: CommandRunner;
  private readonly env: Record<string, string | undefined>;
  private readonly uri: string;
  private readonly logger: Logger;
  private readonly options: VmManagerOptions;
  private readonly bridges = new Map<string, VsockBridge>();
  private templates: Promise<TemplateSet> | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: VmManagerOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.paths = options.paths ?? hostPaths(this.env);
    this.runner = options.runner ?? new ExecFileRunner();
    this.uri = options.libvirtUri ?? (this.env.LIBVIRT_DEFAULT_URI || "qemu:///system");
    this.logger = options.logger ?? stderrLogger;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The configured CID base (INVISIBLE_DOTS_CID_BASE). */
  get cidBase(): number {
    return cidBaseFromEnv(this.env);
  }

  /** A CID for a new Dot, given the CIDs recorded for the others. */
  allocateCid(taken: Iterable<number>): number {
    return allocateCid(taken, this.cidBase);
  }

  generateToken(): string {
    return generateToken();
  }

  bridgeSocketPath(dotId: string): string {
    return this.options.bridgeSocketPath?.(dotId) ?? this.paths.bridgeSocket(dotId);
  }

  private loadTemplates(): Promise<TemplateSet> {
    this.templates ??= loadTemplates(this.options.virtualizationDir).catch((error: unknown) => {
      this.templates = undefined;
      throw error;
    });
    return this.templates;
  }

  private virsh(args: string[]) {
    return this.runner.run("virsh", ["-c", this.uri, ...args], { timeoutMs: this.options.timeouts?.virshMs ?? 60_000 });
  }

  private qemuImg(args: string[]) {
    return this.runner.run("qemu-img", args, { timeoutMs: this.options.timeouts?.qemuImgMs ?? 300_000 });
  }

  private vmDir(dotId: string): string {
    const dir = resolve(this.paths.vmDir(dotId));
    const rel = relative(resolve(this.paths.vmsDir), dir);
    // Belt and braces next to assertDotId: this directory is removed recursively on destroy.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new VmManagerError(`refusing VM directory ${dir}: it is not inside ${this.paths.vmsDir}`);
    }
    return dir;
  }

  private validateSpec(spec: ComputerSpec): void {
    assertDotId(spec.dotId);
    assertIntInRange("cid", spec.cid, 3, 0xfffffffe);
    assertIntInRange("cpus", spec.cpus, 1, 16);
    assertIntInRange("memoryMiB", spec.memoryMiB, 256, 1024 * 1024);
    if (!Number.isSafeInteger(spec.diskBytes) || spec.diskBytes <= 0) {
      throw new VmManagerError(`diskBytes must be a positive integer, got ${spec.diskBytes}`);
    }
    if (!spec.token) throw new VmManagerError("the Dot token is empty");
    if (!isAbsolute(spec.goldenImage) || !isAbsolute(spec.runtimeImage)) {
      throw new VmManagerError("goldenImage and runtimeImage must be absolute paths: libvirt and qemu-img resolve them elsewhere");
    }
  }

  /** Write domain.xml from the template and `virsh define` it. Also updates a running domain's persistent definition. */
  private async defineDomain(spec: ComputerSpec): Promise<string> {
    const templates = await this.loadTemplates();
    const dir = this.vmDir(spec.dotId);
    const xml = renderDomainXml(templates.domain, {
      dotId: spec.dotId,
      cid: spec.cid,
      cpus: spec.cpus,
      memoryMiB: spec.memoryMiB,
      diskPath: join(dir, "disk.qcow2"),
      seedPath: join(dir, "seed.iso"),
      runtimeImage: spec.runtimeImage,
      serialLog: join(dir, "serial.log"),
    });
    const xmlPath = join(dir, "domain.xml");
    await writeFile(xmlPath, xml, { mode: 0o644 });
    await this.virsh(["define", xmlPath]);
    return xmlPath;
  }

  /** Write seed.iso: cloud-localds when installed, else xorriso (section 3.1 lists both). */
  private async writeSeed(spec: ComputerSpec, seedPath: string): Promise<void> {
    const templates = await this.loadTemplates();
    const seed = renderSeed(templates.seed, spec.dotId, spec.token);
    // The staging directory holds the token in clear, so it lives only as long as this call.
    const staging = await mkdtemp(join(this.vmDir(spec.dotId), ".seed-"));
    try {
      const userData = join(staging, "user-data");
      const metaData = join(staging, "meta-data");
      await writeFile(userData, seed.userData, { mode: 0o600 });
      await writeFile(metaData, seed.metaData, { mode: 0o600 });
      const timeoutMs = this.options.timeouts?.isoMs ?? 60_000;
      try {
        await this.runner.run("cloud-localds", [seedPath, userData, metaData], { timeoutMs });
      } catch (error) {
        if (!(error instanceof CommandError && error.notFound)) throw error;
        this.logger.info("cloud-localds not installed, writing the seed with xorriso", { dotId: spec.dotId });
        await this.runner.run("xorriso", ["-as", "mkisofs", "-o", seedPath, "-V", "cidata", "-J", "-r", userData, metaData], {
          timeoutMs,
        });
      }
      await chmod(seedPath, 0o600).catch((error: NodeJS.ErrnoException) => {
        // The fake runners of the tests write no file; a real run always has one.
        if (error.code !== "ENOENT") throw error;
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Provision a Dot's computer (section 9.4, up to `virsh define`): the overlay
   * backed by the golden image, the NoCloud seed and the domain. Safe to call
   * again after a failure: an existing disk is kept, the seed and the domain
   * are rewritten.
   */
  async createVM(spec: ComputerSpec): Promise<CreateVmResult> {
    this.validateSpec(spec);
    for (const [label, path] of [
      ["golden image", spec.goldenImage],
      ["runtime ISO", spec.runtimeImage],
    ] as const) {
      await access(path).catch(() => {
        throw new VmManagerError(`${label} ${path} does not exist: build it with guest/image-builder first`);
      });
    }
    const dir = this.vmDir(spec.dotId);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const diskPath = join(dir, "disk.qcow2");
    const seedPath = join(dir, "seed.iso");

    let diskCreated = false;
    const diskExists = await access(diskPath).then(
      () => true,
      () => false,
    );
    if (diskExists) {
      this.logger.warn("overlay already exists, keeping it", { dotId: spec.dotId, disk: diskPath });
    } else {
      await this.qemuImg(["create", "-f", "qcow2", "-F", "qcow2", "-b", spec.goldenImage, diskPath, String(spec.diskBytes)]);
      diskCreated = true;
    }
    await this.writeSeed(spec, seedPath);
    const xmlPath = await this.defineDomain(spec);
    this.logger.info("vm defined", { dotId: spec.dotId, domain: domainName(spec.dotId), cid: spec.cid });
    return { domainName: domainName(spec.dotId), vmDir: dir, diskPath, seedPath, xmlPath, diskCreated };
  }

  /** The domain's state from `virsh domstate`. */
  async getVMState(dotId: string): Promise<VmStateInfo> {
    assertDotId(dotId);
    try {
      const { stdout } = await this.virsh(["domstate", domainName(dotId)]);
      const libvirt = stdout.trim().split("\n")[0]!.trim();
      return { defined: true, state: mapDomState(libvirt), libvirt };
    } catch (error) {
      if (isDomainMissing(error)) return { defined: false, state: "STOPPED", libvirt: null };
      throw error;
    }
  }

  /**
   * Start the VM and its bridge. The domain is redefined from `spec` first, so
   * a new runtime ISO or new resources take effect on this start. When the
   * kernel says the CID is in use, the next free one is taken and the domain
   * redefined; the result says which CID the VM runs with.
   */
  async startVM(spec: ComputerSpec, options: StartVmOptions = {}): Promise<StartVmResult> {
    this.validateSpec(spec);
    const current = await this.getVMState(spec.dotId);
    if (!current.defined) {
      throw new VmStateError(spec.dotId, `domain ${domainName(spec.dotId)} is not defined; call createVM first`);
    }
    if (current.libvirt !== "shut off") {
      if (current.state === "RUNNING") {
        await this.ensureBridge(spec.dotId, spec.cid);
        return { cid: spec.cid, cidChanged: false, alreadyRunning: true };
      }
      throw new VmStateError(spec.dotId, `cannot start a domain that is "${current.libvirt}"`);
    }

    const tried = new Set<number>(options.reservedCids ?? []);
    tried.add(spec.cid);
    const maxAttempts = this.options.maxCidAttempts ?? 16;
    let cid = spec.cid;
    await this.defineDomain(spec);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.virsh(["start", domainName(spec.dotId)]);
        break;
      } catch (error) {
        if (!(error instanceof CommandError && isCidInUseError(error.stderr)) || attempt >= maxAttempts) throw error;
        const next = allocateCid(tried, this.cidBase);
        tried.add(next);
        this.logger.warn("vsock CID in use on this host, trying another", { dotId: spec.dotId, cid, next, attempt });
        cid = next;
        await this.defineDomain({ ...spec, cid });
      }
    }
    this.logger.info("vm started", { dotId: spec.dotId, cid });
    try {
      await this.ensureBridge(spec.dotId, cid);
    } catch (error) {
      this.logger.error("bridge failed to start; the VM is running without it", {
        dotId: spec.dotId,
        error: (error as Error).message,
      });
      throw error;
    }
    return { cid, cidChanged: cid !== spec.cid, alreadyRunning: false };
  }

  /** Start the bridge if it is not running, or restart it on a different CID. Used after a control plane restart. */
  async ensureBridge(dotId: string, cid: number): Promise<VsockBridge> {
    assertDotId(dotId);
    const existing = this.bridges.get(dotId);
    if (existing && existing.cid === cid) {
      await existing.start();
      return existing;
    }
    if (existing) await this.stopBridge(dotId);
    const bridge = new VsockBridge({
      dotId,
      cid,
      socketPath: this.bridgeSocketPath(dotId),
      runner: this.runner,
      logger: this.logger,
      ...this.options.bridge,
    });
    if (!this.options.bridgeSocketPath) await mkdir(this.paths.runDir, { recursive: true, mode: 0o750 });
    this.bridges.set(dotId, bridge);
    try {
      await bridge.start();
    } catch (error) {
      this.bridges.delete(dotId);
      throw error;
    }
    return bridge;
  }

  async stopBridge(dotId: string): Promise<void> {
    const bridge = this.bridges.get(dotId);
    this.bridges.delete(dotId);
    await bridge?.stop();
  }

  /** Stop every bridge, for a clean control plane shutdown. The VMs keep running. */
  async stopAllBridges(): Promise<void> {
    await Promise.all([...this.bridges.keys()].map((dotId) => this.stopBridge(dotId)));
  }

  bridge(dotId: string): VsockBridge | undefined {
    return this.bridges.get(dotId);
  }

  /** Ask the guest to power off (ACPI) and return at once. */
  async shutdownVM(dotId: string): Promise<void> {
    assertDotId(dotId);
    try {
      await this.virsh(["shutdown", domainName(dotId)]);
    } catch (error) {
      if (!isNotRunning(error)) throw error;
    }
  }

  /**
   * Graceful stop (section 9.5): `virsh shutdown`, wait up to the shutdown
   * timeout for "shut off", then `virsh destroy`; the bridge is stopped either way.
   */
  async stopVM(dotId: string, options: { timeoutMs?: number } = {}): Promise<StopVmResult> {
    assertDotId(dotId);
    const name = domainName(dotId);
    let forced = false;
    const initial = await this.getVMState(dotId);
    if (initial.defined && initial.libvirt !== "shut off") {
      await this.shutdownVM(dotId);
      const timeoutMs = options.timeoutMs ?? this.options.shutdownTimeoutMs ?? 60_000;
      const interval = this.options.pollIntervalMs ?? 1000;
      const deadline = Date.now() + timeoutMs;
      let state = await this.getVMState(dotId);
      while (state.libvirt !== "shut off" && state.defined && Date.now() < deadline) {
        await this.sleep(interval);
        state = await this.getVMState(dotId);
      }
      if (state.defined && state.libvirt !== "shut off") {
        this.logger.warn("guest did not power off in time, destroying", { dotId, timeoutMs, state: state.libvirt });
        try {
          await this.virsh(["destroy", name]);
        } catch (error) {
          if (!isNotRunning(error)) throw error;
        }
        forced = true;
      }
    }
    await this.stopBridge(dotId);
    this.logger.info("vm stopped", { dotId, forced });
    return { forced };
  }

  async rebootVM(dotId: string): Promise<void> {
    assertDotId(dotId);
    await this.virsh(["reboot", domainName(dotId)]);
  }

  /** Remove everything: the bridge, the running domain, its definition and the VM directory with the disk. */
  async destroyVM(dotId: string): Promise<void> {
    assertDotId(dotId);
    const name = domainName(dotId);
    const dir = this.vmDir(dotId);
    await this.stopBridge(dotId);
    const state = await this.getVMState(dotId);
    if (state.defined) {
      if (state.libvirt !== "shut off") {
        try {
          await this.virsh(["destroy", name]);
        } catch (error) {
          if (!isNotRunning(error)) throw error;
        }
      }
      try {
        await this.virsh(["undefine", name]);
      } catch (error) {
        if (!isDomainMissing(error)) throw error;
      }
    }
    await rm(dir, { recursive: true, force: true });
    this.logger.info("vm destroyed", { dotId, dir });
  }

  /** New vCPU count, written to the definition. A running VM picks it up on its next start. */
  async resizeCPU(spec: ComputerSpec, cpus: number): Promise<ResizeResult> {
    assertIntInRange("cpus", cpus, 1, 16);
    return this.redefine({ ...spec, cpus });
  }

  /** New memory size in MiB, written to the definition. A running VM picks it up on its next start. */
  async resizeRAM(spec: ComputerSpec, memoryMiB: number): Promise<ResizeResult> {
    assertIntInRange("memoryMiB", memoryMiB, 256, 1024 * 1024);
    return this.redefine({ ...spec, memoryMiB });
  }

  private async redefine(spec: ComputerSpec): Promise<ResizeResult> {
    this.validateSpec(spec);
    const state = await this.getVMState(spec.dotId);
    if (!state.defined) throw new VmStateError(spec.dotId, "domain is not defined; call createVM first");
    await this.defineDomain(spec);
    return { restartRequired: state.libvirt !== "shut off" };
  }

  /**
   * Grow the overlay with `qemu-img resize`; the guest's cloud-init grows the
   * partition and filesystem on the next boot. Only on a stopped VM, and never
   * smaller: shrinking a disk under a filesystem destroys data.
   */
  async resizeDisk(dotId: string, diskBytes: number): Promise<{ resized: boolean; previousBytes: number }> {
    assertDotId(dotId);
    if (!Number.isSafeInteger(diskBytes) || diskBytes <= 0) {
      throw new VmManagerError(`diskBytes must be a positive integer, got ${diskBytes}`);
    }
    const state = await this.getVMState(dotId);
    if (state.defined && state.libvirt !== "shut off") {
      throw new VmStateError(dotId, `the disk can only be resized while the VM is stopped (it is "${state.libvirt}")`);
    }
    const disk = join(this.vmDir(dotId), "disk.qcow2");
    const { stdout } = await this.qemuImg(["info", "--output=json", "-U", disk]);
    let previousBytes: number;
    try {
      previousBytes = Number((JSON.parse(stdout) as { "virtual-size": number })["virtual-size"]);
    } catch (error) {
      throw new VmManagerError(`cannot read the size of ${disk} from qemu-img info`, { cause: error });
    }
    if (diskBytes < previousBytes) {
      throw new VmManagerError(`dot ${dotId}: the disk is ${previousBytes} bytes; shrinking it to ${diskBytes} is not supported`);
    }
    if (diskBytes === previousBytes) return { resized: false, previousBytes };
    await this.qemuImg(["resize", "-f", "qcow2", disk, String(diskBytes)]);
    this.logger.info("disk resized", { dotId, previousBytes, diskBytes });
    return { resized: true, previousBytes };
  }

  /** A client for every guest route of this Dot, through its bridge. */
  guestClient(dotId: string, token: string, options: GuestClientOptions = {}): GuestClient {
    assertDotId(dotId);
    return new GuestClient(this.bridgeSocketPath(dotId), token, { logger: this.logger, ...options });
  }

  // Snapshots and rollback are out of scope (architecture section 10).

  createSnapshot(_dotId: string, _name: string): Promise<never> {
    return Promise.reject(new NotImplementedError("VM snapshots"));
  }

  listSnapshots(_dotId: string): Promise<never> {
    return Promise.reject(new NotImplementedError("VM snapshots"));
  }

  restoreSnapshot(_dotId: string, _name: string): Promise<never> {
    return Promise.reject(new NotImplementedError("VM snapshot rollback"));
  }

  deleteSnapshot(_dotId: string, _name: string): Promise<never> {
    return Promise.reject(new NotImplementedError("VM snapshots"));
  }
}
