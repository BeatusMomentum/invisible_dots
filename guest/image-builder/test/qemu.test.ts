import { qemuArgs } from "@invisible-dots/vm-manager";
import { describe, expect, it } from "vitest";
import { builderQemuArgs } from "../src/qemu.js";

const spec = {
  cpus: 2,
  memoryMib: 4096,
  disk: "/home/u/.invisible-dots/images/.golden-v1.work/disk.qcow2",
  seed: "/home/u/.invisible-dots/images/.golden-v1.work/seed.iso",
  serialLog: "/home/u/.invisible-dots/images/.golden-v1.work/serial.log",
};

/** The value that follows `flag`, for every occurrence. */
function values(args: string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));
}

describe("builderQemuArgs", () => {
  it("differs between hosts only in the accelerator", () => {
    const kvm = builderQemuArgs({ ...spec, accelerator: "kvm" });
    const whpx = builderQemuArgs({ ...spec, accelerator: "whpx" });
    expect(values(kvm, "-accel")).toEqual(["kvm"]);
    expect(values(whpx, "-accel")).toEqual(["whpx"]);
    expect(kvm.map((arg) => (arg === "kvm" ? "<accel>" : arg))).toEqual(whpx.map((arg) => (arg === "whpx" ? "<accel>" : arg)));
  });

  it("uses the Dot machine, CPU model and devices, and no host-facing channel", () => {
    const args = builderQemuArgs({ ...spec, accelerator: "kvm" });
    expect(values(args, "-machine")).toEqual(["q35"]);
    expect(values(args, "-cpu")).toEqual(["host"]);
    expect(values(args, "-smp")).toEqual(["2"]);
    expect(values(args, "-m")).toEqual(["4096"]);
    expect(values(args, "-drive")).toEqual([
      `if=virtio,file=${spec.disk},format=qcow2,discard=unmap`,
      `media=cdrom,file=${spec.seed},format=raw,readonly=on`,
    ]);
    expect(values(args, "-netdev")).toEqual(["user,id=net0"]);
    expect(values(args, "-device")).toEqual(["virtio-net-pci,netdev=net0", "virtio-rng-pci"]);
    expect(values(args, "-serial")).toEqual([`file:${spec.serialLog}`]);
    expect(values(args, "-display")).toEqual(["none"]);
    expect(values(args, "-monitor")).toEqual(["none"]);
    expect(args).toContain("-no-reboot");
    // No monitor and no port forward: nothing on the host is reachable from or controls this VM.
    expect(args).not.toContain("-qmp");
    expect(args.join(" ")).not.toContain("hostfwd");
    // Never a software fallback.
    expect(args.join(" ")).not.toMatch(/tcg|enable-kvm/);
  });

  it("is the Dot command line without its forward and runtime ISO, plus only the builder's own flags", () => {
    const builder = builderQemuArgs({ ...spec, accelerator: "whpx" });
    const dot = qemuArgs({
      dotId: "dot_x",
      accelerator: "whpx",
      cpus: spec.cpus,
      memoryMiB: spec.memoryMib,
      diskPath: spec.disk,
      seedPath: spec.seed,
      runtimeIsoPath: "/images/runtime-1.iso",
      guestPort: 40000,
      serialLogPath: spec.serialLog,
    });
    // The Dot's argv after its name, without the runtime ISO drive, and with the forward taken off the netdev.
    const runtime = dot.indexOf("media=cdrom,file=/images/runtime-1.iso,format=raw,readonly=on");
    const rest = [...dot.slice(2, runtime - 1), ...dot.slice(runtime + 1)].map((arg) => (arg.startsWith("user,id=net0,hostfwd") ? "user,id=net0" : arg));
    expect(builder).toEqual(["-name", "invisible-dots-image-builder", ...rest, "-monitor", "none", "-no-reboot"]);
  });

  it("refuses a path with a comma, as the Dots' own command line does", () => {
    // A comma would let the rest of the path become further QEMU options, and
    // a home no Dot can run from must not get as far as a finished image.
    expect(() => builderQemuArgs({ ...spec, accelerator: "whpx", disk: "C:\\Users\\A, B\\disk.qcow2" })).toThrow(/comma/);
    expect(() => builderQemuArgs({ ...spec, accelerator: "kvm", seed: "/srv/a,format=raw/seed.iso" })).toThrow(/comma/);
    expect(() => builderQemuArgs({ ...spec, accelerator: "kvm", serialLog: "/srv/a,b/serial.log" })).toThrow(/comma/);
  });

  it("passes Windows paths with spaces through unchanged", () => {
    const args = builderQemuArgs({ ...spec, accelerator: "whpx", disk: "C:\\Users\\A B\\disk.qcow2", seed: "C:\\Users\\A B\\seed.iso", serialLog: "C:\\Users\\A B\\serial.log" });
    expect(values(args, "-drive")[0]).toBe("if=virtio,file=C:\\Users\\A B\\disk.qcow2,format=qcow2,discard=unmap");
    expect(values(args, "-drive")[1]).toBe("media=cdrom,file=C:\\Users\\A B\\seed.iso,format=raw,readonly=on");
    expect(values(args, "-serial")).toEqual(["file:C:\\Users\\A B\\serial.log"]);
  });

  it("rejects resources QEMU would misread", () => {
    expect(() => builderQemuArgs({ ...spec, accelerator: "kvm", cpus: 0 })).toThrow(/cpus/);
    expect(() => builderQemuArgs({ ...spec, accelerator: "kvm", cpus: 1.5 })).toThrow(/cpus/);
    expect(() => builderQemuArgs({ ...spec, accelerator: "kvm", memoryMib: 512 })).toThrow(/memory/);
  });
});
