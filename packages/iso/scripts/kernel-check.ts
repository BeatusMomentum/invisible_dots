/**
 * The unit tests read our images back with our own parser, which can share a
 * misreading with the writer. The reader that matters is the Linux kernel's
 * isofs, the one cloud-init and the runtime mount go through, and it needs
 * root to mount. So CI runs this in two halves around a `sudo mount`:
 *
 *   npx tsx packages/iso/scripts/kernel-check.ts write <image.iso>
 *   sudo mount -o loop,ro <image.iso> <dir>
 *   npx tsx packages/iso/scripts/kernel-check.ts verify <dir>
 *
 * The sample covers what the seed and the runtime disk depend on: the
 * `cidata` label cloud-init looks for, nested directories, names longer than
 * ISO 9660 level 1 allows (so the kernel must be reading Joliet), and content
 * that crosses a sector boundary.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { writeIso, type IsoEntry } from "../src/index.js";

export const SAMPLE_LABEL = "cidata";

/** Deterministic content larger than one 2048-byte sector. */
function multiSector(): string {
  return Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n") + "\n";
}

export const SAMPLE_FILES: Record<string, string> = {
  "user-data": "#cloud-config\n",
  "meta-data": "instance-id: kernel-check\n",
  "units/invisible-dots-agent.service": "[Unit]\nDescription=agent\n",
  "units/nested/a-name-longer-than-eight-dot-three.conf": "nested\n",
  "invisible-dots-agent.mjs": multiSector(),
};

async function walk(root: string, dir: string = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, path)));
    else out.push(relative(root, path).split(sep).join("/"));
  }
  return out.sort();
}

async function write(image: string): Promise<void> {
  const entries: IsoEntry[] = Object.entries(SAMPLE_FILES).map(([path, data]) => ({ path, data }));
  const summary = await writeIso(image, entries, { volumeId: SAMPLE_LABEL });
  console.log(`wrote ${image}: ${summary.bytes} bytes`);
}

async function verify(mountPoint: string): Promise<void> {
  const expected = Object.keys(SAMPLE_FILES).sort();
  const actual = await walk(mountPoint);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`the kernel lists ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  for (const [path, data] of Object.entries(SAMPLE_FILES)) {
    const full = join(mountPoint, ...path.split("/"));
    const content = await readFile(full, "utf8");
    if (content !== data) throw new Error(`${path}: the kernel reads different bytes than were written`);
    if ((await stat(full)).size !== Buffer.byteLength(data)) throw new Error(`${path}: wrong size`);
  }
  console.log(`ok: the kernel reads ${actual.length} files with their Joliet names and exact content`);
}

const [mode, target] = process.argv.slice(2);
if (mode === "write" && target) await write(target);
else if (mode === "verify" && target) await verify(target);
else {
  console.error("usage: kernel-check.ts write <image.iso> | verify <mount point>");
  process.exit(2);
}
