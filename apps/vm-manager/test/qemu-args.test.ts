import { describe, expect, it } from "vitest";
import { CPU_MODEL, machineArgs, qemuArgs, qemuPathProblem, VmManagerError, type QemuArgsSpec } from "../src/index.js";

const linux: QemuArgsSpec = {
  dotId: "dot_01k6",
  accelerator: "kvm",
  cpus: 2,
  memoryMiB: 4096,
  diskPath: "/home/u/.invisible-dots/vms/dot_01k6/disk.qcow2",
  seedPath: "/home/u/.invisible-dots/vms/dot_01k6/seed.iso",
  runtimeIsoPath: "/home/u/.invisible-dots/images/runtime-7.iso",
  guestPort: 40123,
  serialLogPath: "/home/u/.invisible-dots/vms/dot_01k6/serial.log",
};

describe("qemuArgs", () => {
  it("is the command line of section 3.4, argument by argument", () => {
    expect(qemuArgs(linux)).toEqual([
      "-name", "invisible-dot-dot_01k6",
      "-machine", "q35", "-accel", "kvm", "-cpu", "host,-vmx,-svm",
      "-smp", "2", "-m", "4096",
      "-drive", "if=virtio,file=/home/u/.invisible-dots/vms/dot_01k6/disk.qcow2,format=qcow2,discard=unmap",
      "-drive", "media=cdrom,file=/home/u/.invisible-dots/vms/dot_01k6/seed.iso,format=raw,readonly=on",
      "-drive", "media=cdrom,file=/home/u/.invisible-dots/images/runtime-7.iso,format=raw,readonly=on",
      "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:40123-:1024",
      "-device", "virtio-net-pci,netdev=net0",
      "-device", "virtio-rng-pci",
      "-serial", "file:/home/u/.invisible-dots/vms/dot_01k6/serial.log",
      "-display", "none",
    ]); // prettier-ignore
  });

  it("differs on Windows only in the accelerator and the paths it is given", () => {
    const base = "C:\\Users\\u\\.invisible-dots";
    const windows: QemuArgsSpec = {
      ...linux,
      accelerator: "whpx",
      diskPath: `${base}\\vms\\dot_01k6\\disk.qcow2`,
      seedPath: `${base}\\vms\\dot_01k6\\seed.iso`,
      runtimeIsoPath: `${base}\\images\\runtime-7.iso`,
      serialLogPath: `${base}\\vms\\dot_01k6\\serial.log`,
    };
    const a = qemuArgs(linux);
    const b = qemuArgs(windows);
    expect(b.length).toBe(a.length);
    const differing = a.flatMap((value, index) => (value === b[index] ? [] : [index]));
    expect(differing.map((index) => a[index - 1])).toEqual(["-accel", "-drive", "-drive", "-drive", "-serial"]);
  });

  it("never asks for a fallback CPU model or software emulation", () => {
    const args = qemuArgs(linux).join(" ");
    expect(args).not.toMatch(/tcg|max/);
    expect(args).toMatch(/-cpu host,/);
  });

  it("gives every accelerator the host CPU without the virtualization extensions", () => {
    // Measured with QEMU 11.1 under WHPX (architecture section 3.4): plain `host` and `max` pause the VM
    // with "WHPX: Unexpected VP exit code 4" because the guest sees VMX; `host,-vmx` boots to the login.
    expect(CPU_MODEL).toBe("host,-vmx,-svm");
    for (const accelerator of ["kvm", "whpx"] as const) {
      const args = machineArgs({ accelerator, cpus: 2, memoryMiB: 2048 });
      expect(args[args.indexOf("-cpu") + 1]).toBe(CPU_MODEL);
      const features = CPU_MODEL.split(",").slice(1);
      expect(features).toEqual(expect.arrayContaining(["-vmx", "-svm"]));
      expect(CPU_MODEL.split(",")[0]).toBe("host");
    }
  });

  it("has no monitor and nothing that pauses the VM", () => {
    // The VM is reached through the guest channel only, and a paused VM would look started (section 3.4).
    const args = qemuArgs(linux);
    for (const flag of ["-S", "-qmp", "-qmp-pretty", "-monitor", "-mon", "-chardev", "-pidfile", "-daemonize", "-no-shutdown", "-incoming"]) {
      expect(args).not.toContain(flag);
    }
    expect(args.join(" ")).not.toMatch(/qmp|monitor|stdio/);
  });

  it("refuses paths QEMU's option syntax would split", () => {
    expect(() => qemuArgs({ ...linux, diskPath: "/home/a,b/disk.qcow2" })).toThrow(VmManagerError);
    expect(() => qemuArgs({ ...linux, serialLogPath: "/home/a,b/serial.log" })).toThrow(/INVISIBLE_DOTS_HOME/);
  });

  it("refuses a path with any character outside plain ASCII, on every host", () => {
    // Measured with the pinned Windows QEMU 11.1: both fail to open as -drive files.
    for (const home of ["/home/caf\u00e9", "C:\\Users\\\u0416\u0443\u043a", "/home/\u6d4b\u8bd5"]) {
      expect(() => qemuArgs({ ...linux, diskPath: `${home}/.invisible-dots/vms/dot_01k6/disk.qcow2` })).toThrow(/plain ASCII.*INVISIBLE_DOTS_HOME/);
    }
    expect(qemuPathProblem("/home/u/.invisible-dots/vms/dot_01k6/disk.qcow2")).toBeUndefined();
    expect(qemuPathProblem("C:\\Program Files\\x")).toBeUndefined();
  });

  it("checks the numbers it is given", () => {
    expect(() => qemuArgs({ ...linux, cpus: 0 })).toThrow(/cpus/);
    expect(() => qemuArgs({ ...linux, cpus: 17 })).toThrow(/cpus/);
    expect(() => qemuArgs({ ...linux, memoryMiB: 1.5 })).toThrow(/memoryMiB/);
    expect(() => qemuArgs({ ...linux, guestPort: 0 })).toThrow(/guestPort/);
    expect(() => qemuArgs({ ...linux, guestPort: 65536 })).toThrow(/guestPort/);
  });
});
