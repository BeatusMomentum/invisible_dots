import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NotImplementedError,
  VmManager,
  VmStateError,
  computerSpecFromConfig,
  generateToken,
  mapDomState,
  silentLogger,
  type ComputerSpec,
} from "../src/index.js";
import { FakeRunner, fail, notFound, type Handler } from "./fakes.js";

const DOT = "dot_01k6h3w2ze8m4qv7r1xk9bntc5";
const DOMAIN = `invisible-dot-${DOT}`;
const URI = ["-c", "qemu:///system"];

/** A pretend libvirt: domain name to `virsh domstate` text. */
class FakeLibvirt {
  domains = new Map<string, string>();
  /** Called on `virsh start`; return a stderr to make it fail. */
  onStart: (attempt: number) => string | undefined = () => undefined;
  /** State the domain moves to on `virsh shutdown`. */
  afterShutdown = "shut off";
  starts = 0;
  definedXml: string[] = [];

  handler: Handler = async (command, args) => {
    if (command !== "virsh") return undefined;
    expect(args.slice(0, 2)).toEqual(URI);
    const [sub, target] = args.slice(2);
    const state = this.domains.get(target!);
    switch (sub) {
      case "domstate":
        if (state === undefined) fail(command, args, `error: failed to get domain '${target}'`);
        return { stdout: `${state}\n\n`, stderr: "" };
      case "define": {
        this.definedXml.push(await readFile(target!, "utf8"));
        const name = /<name>([^<]+)<\/name>/.exec(this.definedXml.at(-1)!)![1]!;
        if (!this.domains.has(name)) this.domains.set(name, "shut off");
        return { stdout: `Domain '${name}' defined from ${target}\n`, stderr: "" };
      }
      case "start": {
        this.starts++;
        const error = this.onStart(this.starts);
        if (error) fail(command, args, error);
        this.domains.set(target!, "running");
        return undefined;
      }
      case "shutdown":
        if (state !== "running") fail(command, args, "error: Requested operation is not valid: domain is not running");
        this.domains.set(target!, this.afterShutdown);
        return undefined;
      case "destroy":
        if (state !== "running" && state !== "in shutdown") fail(command, args, "error: Requested operation is not valid: domain is not running");
        this.domains.set(target!, "shut off");
        return undefined;
      case "undefine":
        this.domains.delete(target!);
        return undefined;
      case "reboot":
        return undefined;
      default:
        throw new Error(`unexpected virsh ${sub}`);
    }
  };
}

let root: string;
let libvirt: FakeLibvirt;
let runner: FakeRunner;
let manager: VmManager;
let spec: ComputerSpec;

function makeManager(extra: Partial<ConstructorParameters<typeof VmManager>[0]> = {}) {
  return new VmManager({
    runner,
    env: { INVISIBLE_DOTS_STATE_DIR: join(root, "state"), INVISIBLE_DOTS_RUN_DIR: join(root, "run") },
    logger: silentLogger,
    pollIntervalMs: 5,
    bridge: { socketExists: async () => true },
    ...extra,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "idots-vmm-"));
  const images = join(root, "state", "images");
  await mkdir(images, { recursive: true });
  await writeFile(join(images, "golden-1.qcow2"), "");
  await writeFile(join(images, "runtime-1.iso"), "");
  libvirt = new FakeLibvirt();
  runner = new FakeRunner(libvirt.handler);
  manager = makeManager();
  spec = {
    dotId: DOT,
    cid: 10000,
    token: "secret-token",
    goldenImage: join(images, "golden-1.qcow2"),
    runtimeImage: join(images, "runtime-1.iso"),
    cpus: 2,
    memoryMiB: 4096,
    diskBytes: 40 * 1024 ** 3,
  };
});

afterEach(async () => {
  await manager.stopAllBridges();
  await rm(root, { recursive: true, force: true });
});

const vmDir = () => resolve(join(root, "state"), "vms", DOT);

describe("createVM", () => {
  it("creates the overlay, the seed and the domain with exact argv", async () => {
    const result = await manager.createVM(spec);
    const disk = join(vmDir(), "disk.qcow2");
    const seed = join(vmDir(), "seed.iso");
    expect(result).toMatchObject({ domainName: DOMAIN, diskPath: disk, seedPath: seed, diskCreated: true });

    const [create, localds, define] = runner.calls;
    expect([create!.command, ...create!.args]).toEqual([
      "qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", spec.goldenImage, disk, String(40 * 1024 ** 3),
    ]);
    expect(localds!.command).toBe("cloud-localds");
    expect(localds!.args[0]).toBe(seed);
    expect(localds!.args[1]).toMatch(/[\\/]\.seed-[^\\/]+[\\/]user-data$/);
    expect(localds!.args[2]).toMatch(/[\\/]\.seed-[^\\/]+[\\/]meta-data$/);
    expect([define!.command, ...define!.args]).toEqual(["virsh", ...URI, "define", join(vmDir(), "domain.xml")]);
    expect(runner.calls).toHaveLength(3);

    const xml = libvirt.definedXml[0]!;
    expect(xml).toContain(`<source file='${disk}'/>`);
    expect(xml).toContain("<cid auto='no' address='10000'/>");
    expect(xml).not.toContain("secret-token");
  });

  it("removes the seed staging directory, which holds the token", async () => {
    let seenUserData = "";
    runner.handler = async (command, args) => {
      if (command === "cloud-localds") seenUserData = await readFile(args[1]!, "utf8");
      return libvirt.handler(command, args);
    };
    await manager.createVM(spec);
    expect(seenUserData).toContain("secret-token");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(vmDir())).filter((name) => name.startsWith(".seed-"))).toEqual([]);
  });

  it("falls back to xorriso when cloud-localds is not installed", async () => {
    runner.handler = (command, args) => (command === "cloud-localds" ? notFound(command, args) : libvirt.handler(command, args));
    await manager.createVM(spec);
    const xorriso = runner.calls.find((call) => call.command === "xorriso")!;
    expect(xorriso.args.slice(0, 8)).toEqual(["-as", "mkisofs", "-o", join(vmDir(), "seed.iso"), "-V", "cidata", "-J", "-r"]);
    expect(xorriso.args.slice(8).map((p) => p.replace(/.*[\\/]/, ""))).toEqual(["user-data", "meta-data"]);
  });

  it("does not hide other cloud-localds failures", async () => {
    runner.handler = (command, args) => (command === "cloud-localds" ? fail(command, args, "disk full") : libvirt.handler(command, args));
    await expect(manager.createVM(spec)).rejects.toThrow(/cloud-localds .*disk full/);
  });

  it("never overwrites an existing disk", async () => {
    await mkdir(vmDir(), { recursive: true });
    await writeFile(join(vmDir(), "disk.qcow2"), "precious");
    const result = await manager.createVM(spec);
    expect(result.diskCreated).toBe(false);
    expect(runner.calls.some((call) => call.command === "qemu-img")).toBe(false);
    expect(await readFile(join(vmDir(), "disk.qcow2"), "utf8")).toBe("precious");
  });

  it("says which image is missing", async () => {
    await expect(manager.createVM({ ...spec, goldenImage: join(root, "nope.qcow2") })).rejects.toThrow(/golden image .*nope\.qcow2 does not exist/);
  });

  it("refuses dot ids that could escape the VM directory", async () => {
    await expect(manager.createVM({ ...spec, dotId: "../etc" })).rejects.toThrow(/invalid dot id/);
  });

  it("builds a spec from a Dot config", () => {
    const built = computerSpecFromConfig(
      DOT,
      { computer: { cpu: 4, memory: "8gb", disk: "40gb", idle_timeout: "15m" } },
      { cid: 10001, token: "t", goldenImage: "/g", runtimeImage: "/r" },
    );
    expect(built).toEqual({ dotId: DOT, cid: 10001, token: "t", goldenImage: "/g", runtimeImage: "/r", cpus: 4, memoryMiB: 8192, diskBytes: 40 * 1024 ** 3 });
  });
});

describe("startVM", () => {
  beforeEach(async () => {
    await manager.createVM(spec);
    runner.calls = [];
  });

  it("redefines, starts and brings up the bridge", async () => {
    const result = await manager.startVM(spec);
    expect(result).toEqual({ cid: 10000, cidChanged: false, alreadyRunning: false });
    expect(runner.lines().map((line) => line.replace(/ define .*/, " define <xml>"))).toEqual([
      `virsh ${URI.join(" ")} domstate ${DOMAIN}`,
      `virsh ${URI.join(" ")} define <xml>`,
      `virsh ${URI.join(" ")} start ${DOMAIN}`,
    ]);
    const socat = runner.spawned[0]!;
    expect(socat.command).toBe("socat");
    expect(socat.args).toEqual([
      `UNIX-LISTEN:${manager.paths.bridgeSocket(DOT)},fork,mode=600`,
      "VSOCK-CONNECT:10000:1024",
    ]);
    expect(manager.bridge(DOT)?.running).toBe(true);
  });

  it("moves to another CID when the kernel says the address is in use", async () => {
    libvirt.onStart = (attempt) =>
      attempt <= 2 ? "error: Failed to start domain\nerror: internal error: unable to set guest cid: Address already in use" : undefined;
    const result = await manager.startVM(spec, { reservedCids: [10001, 10003] });
    // 10000 was in use, 10001 is held by another Dot, 10002 was in use too, 10003 is another Dot's.
    expect(result).toEqual({ cid: 10004, cidChanged: true, alreadyRunning: false });
    expect(libvirt.starts).toBe(3);
    expect(libvirt.definedXml.at(-1)).toContain("<cid auto='no' address='10004'/>");
    expect(runner.spawned[0]!.args[1]).toBe("VSOCK-CONNECT:10004:1024");
  });

  it("gives up after the configured number of CID attempts", async () => {
    manager = makeManager({ maxCidAttempts: 2 });
    libvirt.onStart = () => "error: Address already in use";
    await expect(manager.startVM(spec)).rejects.toThrow(/Address already in use/);
    expect(libvirt.starts).toBe(2);
  });

  it("does not retry other start failures", async () => {
    libvirt.onStart = () => "error: Cannot access storage file";
    await expect(manager.startVM(spec)).rejects.toThrow(/Cannot access storage file/);
    expect(libvirt.starts).toBe(1);
  });

  it("only ensures the bridge when the VM already runs", async () => {
    libvirt.domains.set(DOMAIN, "running");
    expect(await manager.startVM(spec)).toEqual({ cid: 10000, cidChanged: false, alreadyRunning: true });
    expect(libvirt.starts).toBe(0);
    expect(runner.spawned).toHaveLength(1);
  });

  it("refuses an undefined domain", async () => {
    libvirt.domains.clear();
    await expect(manager.startVM(spec)).rejects.toBeInstanceOf(VmStateError);
  });

  it("starts at INVISIBLE_DOTS_CID_BASE when reallocating", async () => {
    manager = makeManager({
      env: { INVISIBLE_DOTS_STATE_DIR: join(root, "state"), INVISIBLE_DOTS_RUN_DIR: join(root, "run"), INVISIBLE_DOTS_CID_BASE: "50000" },
    });
    libvirt.onStart = (attempt) => (attempt === 1 ? "Address already in use" : undefined);
    expect((await manager.startVM(spec)).cid).toBe(50000);
  });
});

describe("stopVM and friends", () => {
  beforeEach(async () => {
    await manager.createVM(spec);
    await manager.startVM(spec);
    runner.calls = [];
  });

  it("shuts down gracefully and stops the bridge", async () => {
    const socat = runner.spawned[0]!;
    expect(await manager.stopVM(DOT)).toEqual({ forced: false });
    expect(runner.lines()).toContain(`virsh ${URI.join(" ")} shutdown ${DOMAIN}`);
    expect(runner.lines().some((line) => line.includes(" destroy "))).toBe(false);
    expect(socat.killed).toEqual(["SIGTERM"]);
    expect(manager.bridge(DOT)).toBeUndefined();
  });

  it("destroys the domain when the guest ignores the shutdown", async () => {
    libvirt.afterShutdown = "running";
    expect(await manager.stopVM(DOT, { timeoutMs: 30 })).toEqual({ forced: true });
    expect(runner.lines().at(-1)).toBe(`virsh ${URI.join(" ")} destroy ${DOMAIN}`);
    expect(libvirt.domains.get(DOMAIN)).toBe("shut off");
  });

  it("is a no-op on a stopped VM apart from the bridge", async () => {
    libvirt.domains.set(DOMAIN, "shut off");
    expect(await manager.stopVM(DOT)).toEqual({ forced: false });
    expect(runner.lines()).toEqual([`virsh ${URI.join(" ")} domstate ${DOMAIN}`]);
  });

  it("shutdownVM and rebootVM issue one virsh call", async () => {
    await manager.rebootVM(DOT);
    await manager.shutdownVM(DOT);
    expect(runner.lines()).toEqual([`virsh ${URI.join(" ")} reboot ${DOMAIN}`, `virsh ${URI.join(" ")} shutdown ${DOMAIN}`]);
  });

  it("destroyVM removes the domain and the VM directory", async () => {
    await manager.destroyVM(DOT);
    expect(runner.lines().filter((line) => !line.includes(" domstate "))).toEqual([
      `virsh ${URI.join(" ")} destroy ${DOMAIN}`,
      `virsh ${URI.join(" ")} undefine ${DOMAIN}`,
    ]);
    await expect(stat(vmDir())).rejects.toMatchObject({ code: "ENOENT" });
    expect(libvirt.domains.has(DOMAIN)).toBe(false);
    expect(manager.bridge(DOT)).toBeUndefined();
  });

  it("destroyVM succeeds on a domain that is already gone", async () => {
    libvirt.domains.clear();
    await manager.destroyVM(DOT);
    await expect(stat(vmDir())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("state", () => {
  it("maps virsh domstate", () => {
    expect(mapDomState("running")).toBe("RUNNING");
    expect(mapDomState("idle")).toBe("RUNNING");
    expect(mapDomState("in shutdown")).toBe("STOPPING");
    expect(mapDomState("shut off")).toBe("STOPPED");
    expect(mapDomState("paused")).toBe("ERROR");
    expect(mapDomState("crashed")).toBe("ERROR");
    expect(mapDomState("pmsuspended")).toBe("ERROR");
  });

  it("reports an undefined domain", async () => {
    expect(await manager.getVMState(DOT)).toEqual({ defined: false, state: "STOPPED", libvirt: null });
  });

  it("reports a running domain", async () => {
    libvirt.domains.set(DOMAIN, "running");
    expect(await manager.getVMState(DOT)).toEqual({ defined: true, state: "RUNNING", libvirt: "running" });
  });

  it("propagates other virsh failures", async () => {
    runner.handler = (command, args) => fail(command, args, "error: failed to connect to the hypervisor");
    await expect(manager.getVMState(DOT)).rejects.toThrow(/failed to connect to the hypervisor/);
  });
});

describe("resize", () => {
  beforeEach(async () => {
    await manager.createVM(spec);
    runner.calls = [];
  });

  it("writes new vCPUs and memory into the definition", async () => {
    expect(await manager.resizeCPU(spec, 4)).toEqual({ restartRequired: false });
    expect(libvirt.definedXml.at(-1)).toContain("<vcpu placement='static'>4</vcpu>");
    libvirt.domains.set(DOMAIN, "running");
    expect(await manager.resizeRAM(spec, 8192)).toEqual({ restartRequired: true });
    expect(libvirt.definedXml.at(-1)).toContain("<memory unit='MiB'>8192</memory>");
  });

  it("rejects out-of-range values", async () => {
    await expect(manager.resizeCPU(spec, 0)).rejects.toThrow(/cpus must be an integer/);
    await expect(manager.resizeCPU(spec, 17)).rejects.toThrow(/cpus/);
  });

  it("grows the disk with qemu-img on a stopped VM", async () => {
    const disk = join(vmDir(), "disk.qcow2");
    runner.handler = (command, args) =>
      command === "qemu-img" && args[0] === "info"
        ? { stdout: JSON.stringify({ "virtual-size": 20 * 1024 ** 3 }), stderr: "" }
        : libvirt.handler(command, args);
    expect(await manager.resizeDisk(DOT, 50 * 1024 ** 3)).toEqual({ resized: true, previousBytes: 20 * 1024 ** 3 });
    expect(runner.lines().slice(1)).toEqual([
      `qemu-img info --output=json -U ${disk}`,
      `qemu-img resize -f qcow2 ${disk} ${50 * 1024 ** 3}`,
    ]);
    await expect(manager.resizeDisk(DOT, 10 * 1024 ** 3)).rejects.toThrow(/shrinking/);
    expect(await manager.resizeDisk(DOT, 20 * 1024 ** 3)).toEqual({ resized: false, previousBytes: 20 * 1024 ** 3 });
  });

  it("refuses a disk resize while running", async () => {
    libvirt.domains.set(DOMAIN, "running");
    await expect(manager.resizeDisk(DOT, 50 * 1024 ** 3)).rejects.toThrow(/only be resized while the VM is stopped/);
    expect(runner.calls.some((call) => call.command === "qemu-img")).toBe(false);
  });
});

describe("misc", () => {
  it("snapshots are out of scope", async () => {
    await expect(manager.createSnapshot(DOT, "s")).rejects.toBeInstanceOf(NotImplementedError);
    await expect(manager.restoreSnapshot(DOT, "s")).rejects.toThrow(/out of scope for this version/);
  });

  it("tokens are long and unique", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it("honours LIBVIRT_DEFAULT_URI", async () => {
    manager = makeManager({ env: { INVISIBLE_DOTS_STATE_DIR: join(root, "state"), LIBVIRT_DEFAULT_URI: "qemu+ssh://h/system" } });
    runner.handler = () => ({ stdout: "shut off\n", stderr: "" });
    await manager.getVMState(DOT);
    expect(runner.calls[0]!.args.slice(0, 2)).toEqual(["-c", "qemu+ssh://h/system"]);
  });

  it("allocates CIDs from the base", () => {
    expect(manager.allocateCid([10000])).toBe(10001);
  });
});
