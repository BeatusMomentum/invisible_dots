/**
 * The builder VM's seed disk. It is one ISO labelled `cidata`: cloud-init's
 * NoCloud datasource reads user-data and meta-data from it, and the
 * provisioner mounts it again to reach its own files, so the builder needs
 * one CD-ROM and no second payload disk.
 */
import type { IsoEntry } from "@invisible-dots/iso";
import { downloadFileName, type GuestPins } from "./pins.js";
import type { PythonLock } from "./python-lock.js";

/** The lock's name on the builder seed, where provision.sh reads it. */
export const SEED_PYTHON_LOCK = "mcp-requirements.lock";

export interface BuilderSeedInput {
  version: string;
  pins: GuestPins;
  userData: Uint8Array;
  provision: Uint8Array;
  /** builder/mcp-requirements.lock, as read, and what it pins. */
  pythonLock: Uint8Array;
  python: PythonLock;
  /** Host paths of the verified tarballs, streamed into the image. */
  nodeTarball: string;
  uvTarball: string;
}

/**
 * pins.env is sourced by provision.sh. Every value was restricted to
 * characters that need no quoting when the pins were parsed, so single
 * quotes are only a second guard; the check below keeps it that way if a
 * caller builds GuestPins by hand.
 */
export function pinsEnv(pins: GuestPins, python: PythonLock): string {
  const values: Array<[string, string]> = [
    ["NODE_VERSION", pins.node.version],
    ["NODE_TARBALL", downloadFileName(pins.node)],
    ["UV_VERSION", pins.uv.version],
    ["UV_TARBALL", downloadFileName(pins.uv)],
    ["MCP_VERSION", python.mcpVersion],
    ["PLAYWRIGHT_VERSION", python.playwrightVersion],
    ["PYTHON_LOCK", SEED_PYTHON_LOCK],
    ["APT_PACKAGES", pins.apt_packages.join(" ")],
  ];
  return values
    .map(([key, value]) => {
      if (!/^[A-Za-z0-9.+_ -]*$/.test(value)) throw new Error(`pins.env: ${key} holds characters that are not allowed: ${value}`);
      return `${key}='${value}'\n`;
    })
    .join("");
}

export function builderMetaData(version: string): string {
  // A new instance-id per build: cloud-init then treats every build as a first boot.
  return `instance-id: idots-golden-${version}\nlocal-hostname: idots-golden-builder\n`;
}

export function builderSeedEntries(input: BuilderSeedInput): IsoEntry[] {
  return [
    { path: "user-data", data: input.userData },
    { path: "meta-data", data: builderMetaData(input.version) },
    { path: "provision.sh", data: input.provision },
    { path: "pins.env", data: pinsEnv(input.pins, input.python) },
    { path: SEED_PYTHON_LOCK, data: input.pythonLock },
    { path: downloadFileName(input.pins.node), file: input.nodeTarball },
    { path: downloadFileName(input.pins.uv), file: input.uvTarball },
  ];
}
