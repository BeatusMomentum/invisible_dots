#!/usr/bin/env node
// Puts the golden image `image build --compress` made into the shape of a release (guest/image-builder/src/prebuilt.ts):
// its manifest, the image cut in parts under the 2 GiB a release asset may hold, and release.json naming each part with
// its size and SHA-256. Prints the tag, golden-<inputs digest>.
//
//   node .github/scripts/golden-release.mjs <images directory> <output directory>
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const PART_BYTES = 1900 * 1024 * 1024;

const [imagesDir, outDir] = process.argv.slice(2);
if (!imagesDir || !outDir) {
  console.error("usage: golden-release.mjs <images directory> <output directory>");
  process.exit(2);
}

const manifests = (await readdir(imagesDir)).filter((name) => /^golden-.+\.json$/.test(name));
if (manifests.length !== 1) {
  console.error(`expected one golden manifest in ${imagesDir}, found ${manifests.length}`);
  process.exit(1);
}
const manifestName = manifests[0];
const manifest = JSON.parse(await readFile(join(imagesDir, manifestName), "utf8"));
const image = join(imagesDir, manifest.file);
await mkdir(outDir, { recursive: true });
await copyFile(join(imagesDir, manifestName), join(outDir, manifestName));

const parts = [];
let out;
let hash;
let written = 0;
const whole = createHash("sha256");
async function closePart() {
  if (!out) return;
  await out.close();
  parts[parts.length - 1].size = written;
  parts[parts.length - 1].sha256 = hash.digest("hex");
  out = undefined;
}
for await (let chunk of createReadStream(image, { highWaterMark: 8 * 1024 * 1024 })) {
  whole.update(chunk);
  while (chunk.length > 0) {
    if (!out) {
      const name = `${basename(manifest.file)}.part${String(parts.length).padStart(2, "0")}`;
      parts.push({ name, size: 0, sha256: "" });
      out = await open(join(outDir, name), "w");
      hash = createHash("sha256");
      written = 0;
    }
    const take = chunk.subarray(0, PART_BYTES - written);
    await out.write(take);
    hash.update(take);
    written += take.length;
    chunk = chunk.subarray(take.length);
    if (written === PART_BYTES) await closePart();
  }
}
await closePart();

const sha256 = whole.digest("hex");
if (sha256 !== manifest.sha256) {
  console.error(`${image} hashes to ${sha256}, its manifest says ${manifest.sha256}`);
  process.exit(1);
}
await writeFile(join(outDir, "release.json"), `${JSON.stringify({ inputs_digest: manifest.inputs_digest, manifest: manifestName, parts }, null, 2)}\n`);
console.log(`golden-${manifest.inputs_digest}`);
