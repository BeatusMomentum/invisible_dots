/**
 * The files of this package that end up inside a guest: the builder's
 * cloud-init and provisioner, and the runtime ISO's install hook, desktop
 * script and systemd units. They are kept as plain files so they can be read,
 * diffed and checked with shell tools, and read from disk at build time.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The package directory (guest/image-builder). A bundled CLI no longer sits
 * next to these files, so it passes the directory it ships them in as
 * `assetRoot` instead.
 */
export function defaultAssetRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export const BUILDER_USER_DATA = "builder/user-data.yaml";
export const BUILDER_PROVISION = "builder/provision.sh";
/** The hashed lock of the MCP server's Python environment (python-lock.ts). */
export const BUILDER_PYTHON_LOCK = "builder/mcp-requirements.lock";
export const RUNTIME_INSTALL = "runtime/install.sh";
export const RUNTIME_DESKTOP = "runtime/dot-desktop.sh";
/** The guest units, in the order install.sh enables them. */
export const GUEST_UNITS = ["dot-desktop.service", "dot-agentd.service", "invisible-dots-agent.service"] as const;

export function unitAsset(name: (typeof GUEST_UNITS)[number]): string {
  return `units/${name}`;
}

/** Every guest file, for checks that apply to all of them. */
export const GUEST_ASSETS: readonly string[] = [BUILDER_USER_DATA, BUILDER_PROVISION, BUILDER_PYTHON_LOCK, RUNTIME_INSTALL, RUNTIME_DESKTOP, ...GUEST_UNITS.map(unitAsset)];

/**
 * Reads a guest file and refuses one a Windows checkout turned into CRLF:
 * bash reads "#!/usr/bin/env bash\r" as a missing interpreter and systemd
 * misreads the unit, and both happen only inside the guest, long after the
 * build looked fine. Same check on every host.
 */
export async function readGuestAsset(assetRoot: string, relativePath: string): Promise<Buffer> {
  const path = join(assetRoot, relativePath);
  const bytes = await readFile(path);
  if (bytes.includes(0x0d)) {
    throw new Error(`${path} has CR line endings; guest files must be LF (check core.autocrlf and .gitattributes)`);
  }
  return bytes;
}
