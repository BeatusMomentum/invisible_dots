/**
 * Image versions: `<UTC build time>-<digest of the inputs>`.
 *
 * The control plane gives a new Dot the golden image with the highest
 * version and starts every VM with the runtime ISO with the highest version,
 * so the time prefix makes the newest build win. The digest suffix is what
 * makes rebuilding unchanged inputs a no-op: the builder finds the image
 * with that digest and stops.
 */
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { imageVersionOf, type ImageKind } from "@invisible-dots/shared";
import { manifestPathFor } from "./manifest.js";

/** Long enough to never collide between builds of one host, short enough to read. */
export const DIGEST_LENGTH = 12;

export function inputsDigest(parts: ReadonlyArray<Uint8Array | string>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    // Length-prefixed, so moving bytes from one part to the next changes the digest.
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, DIGEST_LENGTH);
}

export function versionFor(now: Date, digest: string): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${stamp}-${digest}`;
}

/** Explicit versions become file names: the same rule as the host paths. */
export function checkVersion(version: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) {
    throw new Error(`invalid image version "${version}": use letters, digits, ".", "_" and "-", starting with a letter or digit`);
  }
  return version;
}

/**
 * An image of that kind in `dir` whose version ends in `-<digest>` and that
 * has its manifest, or undefined. An image without a manifest is not
 * complete (the manifest is written first) and is never reused.
 */
export async function findImageByDigest(dir: string, kind: ImageKind, digest: string): Promise<{ path: string; version: string } | undefined> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.sort().reverse()) {
    const version = imageVersionOf(kind, name);
    if (!version?.endsWith(`-${digest}`)) continue;
    const path = join(dir, name);
    const [image, manifest] = await Promise.all([stat(path).catch(() => undefined), stat(manifestPathFor(path)).catch(() => undefined)]);
    if (image?.isFile() && manifest?.isFile()) return { path, version };
  }
  return undefined;
}
