/**
 * The QEMU command line of a Dot's VM (architecture section 3.4). This is the
 * one function that builds it, on every host; only the accelerator differs,
 * and it arrives here as a value from host.ts.
 */
import { GUEST_PORT, vmName } from "@invisible-dots/shared";
import { VmManagerError } from "./errors.js";
import type { Accelerator } from "./host.js";

export interface QemuArgsSpec {
  dotId: string;
  accelerator: Accelerator;
  cpus: number;
  memoryMiB: number;
  /** All paths absolute: QEMU runs detached and resolves nothing against the control plane's directory. */
  diskPath: string;
  seedPath: string;
  runtimeIsoPath: string;
  /** The free TCP port on 127.0.0.1 forwarded to dot-agentd (section 3.5). */
  guestPort: number;
  serialLogPath: string;
}

/**
 * Why QEMU cannot be given this path, or undefined when it can. The same
 * rule on every host:
 * - QEMU's option syntax gives "," a meaning, and the escape for it (",,")
 *   applies to -drive but not to -serial file:, so no one spelling of a
 *   path with a comma is right everywhere;
 * - a character outside printable ASCII: measured with the pinned Windows
 *   build (QEMU 11.1), qemu-system-x86_64 cannot open a -drive file whose
 *   path holds any (a Latin-1 "é" as much as Cyrillic), and qemu-img cannot
 *   create one outside the system code page. Linux would take UTF-8, but a
 *   home that works on one host and not on the other is the divergence
 *   section 1.1 rules out, and the default home sits under the account name.
 */
export function qemuPathProblem(path: string): string | undefined {
  if (path.includes("\n") || path.includes("\r")) return "contains a line break";
  if (path.includes(",")) return "contains a comma, which QEMU's command line cannot carry";
  if (/[^\x20-\x7e]/.test(path)) return "contains a character outside plain ASCII, which QEMU on Windows cannot open";
  return undefined;
}

/** A host path for QEMU's command line, refused with the fix when qemuPathProblem names one. */
export function qemuPathArg(label: string, path: string): string {
  const problem = qemuPathProblem(path);
  if (problem) {
    throw new VmManagerError(`${label} ${JSON.stringify(path)} ${problem}; set INVISIBLE_DOTS_HOME to a directory whose path is plain ASCII without commas`);
  }
  return path;
}

function integerInRange(label: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new VmManagerError(`${label} must be an integer from ${min} to ${max}, got ${value}`);
  }
  return value;
}

/**
 * The machine every VM of this project runs on, Dots and the image
 * builder's VM alike, so a golden image is provisioned on the machine type,
 * accelerator and CPU model a Dot later boots it on: changing one here
 * changes both.
 */
export function machineArgs(spec: { accelerator: Accelerator; cpus: number; memoryMiB: number }): string[] {
  return [
    "-machine",
    "q35",
    "-accel",
    spec.accelerator,
    "-cpu",
    "host",
    "-smp",
    String(integerInRange("cpus", spec.cpus, 1, 16)),
    "-m",
    String(integerInRange("memoryMiB", spec.memoryMiB, 256, 64 * 1024)),
  ];
}

/** The `-drive` value of a VM's qcow2 system disk. */
export function diskDriveArg(path: string): string {
  return `if=virtio,file=${qemuPathArg("disk", path)},format=qcow2,discard=unmap`;
}

/**
 * The `-drive` value of a read-only CD-ROM (a seed or the runtime ISO).
 * format=raw: an ISO is raw, and naming it stops QEMU probing the format.
 */
export function cdromDriveArg(label: string, path: string): string {
  return `media=cdrom,file=${qemuPathArg(label, path)},format=raw,readonly=on`;
}

/**
 * User-mode networking (`netdev` says whether a port is forwarded), the
 * random number device, the serial console to a file and no display: the
 * devices every VM of this project has.
 */
export function deviceArgs(netdev: string, serialLogPath: string): string[] {
  return [
    "-netdev",
    netdev,
    "-device",
    "virtio-net-pci,netdev=net0",
    "-device",
    "virtio-rng-pci",
    "-serial",
    `file:${qemuPathArg("serial log", serialLogPath)}`,
    "-display",
    "none",
  ];
}

/**
 * The argument array after the executable, exactly as section 3.4 lists it.
 * There is no monitor of any kind (no -qmp, no -monitor) and nothing that
 * holds the VM before its first instruction (no -S): the control plane
 * reaches a VM only through the guest channel (section 5.1) and sees its
 * QEMU only as a process.
 */
export function qemuArgs(spec: QemuArgsSpec): string[] {
  const port = integerInRange("guestPort", spec.guestPort, 1, 65535);
  return [
    "-name",
    vmName(spec.dotId),
    ...machineArgs(spec),
    "-drive",
    diskDriveArg(spec.diskPath),
    "-drive",
    cdromDriveArg("seed ISO", spec.seedPath),
    "-drive",
    cdromDriveArg("runtime ISO", spec.runtimeIsoPath),
    ...deviceArgs(`user,id=net0,hostfwd=tcp:127.0.0.1:${port}-:${GUEST_PORT}`, spec.serialLogPath),
  ];
}
