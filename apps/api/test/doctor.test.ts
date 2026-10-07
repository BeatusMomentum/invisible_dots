/** The doctor's image rows: the verdict on an image is kept for as long as the image and its manifest are the same files. */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageCheck } from "@invisible-dots/image-builder";
import { hostPaths } from "@invisible-dots/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImageChecks } from "../src/index.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "idots-doctor-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Both images in the home's images directory, and a `verify` that counts the images it is asked about. */
async function setup(answer: ImageCheck = { ok: true, manifest: {} as never }) {
  const paths = hostPaths({ INVISIBLE_DOTS_HOME: home });
  await mkdir(paths.imagesDir, { recursive: true });
  const golden = join(paths.imagesDir, "golden-1.qcow2");
  const runtime = join(paths.imagesDir, "runtime-1.iso");
  for (const file of [golden, runtime]) await writeFile(file, "image");
  await writeFile(join(paths.imagesDir, "golden-1.json"), "{}");
  await writeFile(join(paths.imagesDir, "runtime-1.json"), "{}");
  const verified: string[] = [];
  const checks = createImageChecks(paths, async (image) => {
    verified.push(image);
    return answer;
  });
  return { checks, verified, golden, runtime, paths };
}

describe("the image rows", () => {
  it("verify each image once while its files stay the same", async () => {
    const { checks, verified, golden, runtime } = await setup();
    const first = await checks();
    expect(first.map((row) => [row.id, row.status])).toEqual([["golden-image", "ok"], ["runtime-image", "ok"]]);
    expect(await checks()).toEqual(first);
    expect(await checks()).toEqual(first);
    expect(verified).toEqual([golden, runtime]);
  });

  it("verify again when the image changes, and when its manifest does", async () => {
    const { checks, verified, golden, runtime, paths } = await setup();
    await checks();
    await writeFile(golden, "a different image");
    await checks();
    expect(verified).toEqual([golden, runtime, golden]);
    const manifest = join(paths.imagesDir, "runtime-1.json");
    await utimes(manifest, new Date(), new Date(Date.now() + 60_000));
    await checks();
    expect(verified).toEqual([golden, runtime, golden, runtime]);
  });

  it("keep a failed verdict too, with the command that fixes it", async () => {
    const { checks, verified } = await setup({ ok: false, reason: "it hashes to the wrong digest", fix: "delete it and run invisible-dots image build" });
    const rows = await checks();
    expect(rows[0]).toMatchObject({ id: "golden-image", status: "failed", detail: "it hashes to the wrong digest", fix: "delete it and run invisible-dots image build" });
    await checks();
    expect(verified).toHaveLength(2);
  });

  it("answer missing without hashing anything when there is no image", async () => {
    const paths = hostPaths({ INVISIBLE_DOTS_HOME: home });
    await mkdir(paths.imagesDir, { recursive: true });
    const verified: string[] = [];
    const rows = await createImageChecks(paths, async (image) => {
      verified.push(image);
      return { ok: false, reason: "unreachable", fix: "" };
    })();
    expect(rows.map((row) => row.status)).toEqual(["missing", "missing"]);
    expect(verified).toEqual([]);
  });
});
