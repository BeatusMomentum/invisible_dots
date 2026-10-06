import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestPathFor, readManifest, verifyImage, writeManifest, type RuntimeManifest } from "../src/manifest.js";
import { sha256 } from "./http-fixture.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-manifest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runtimeManifest(file: string, bytes: Buffer): RuntimeManifest {
  return {
    kind: "runtime",
    version: "v1",
    file,
    sha256: sha256(bytes),
    size_bytes: bytes.length,
    built_at: "2026-10-02T12:00:00.000Z",
    content_digest: "abc",
    files: [],
  };
}

describe("readManifest", () => {
  it("reads the manifest of a golden image built before notices were recorded: the field is absent, not wrong", async () => {
    const path = join(dir, "golden-old.json");
    const old = { kind: "golden", version: "old", file: "golden-old.qcow2", sha256: sha256(Buffer.from("x")), size_bytes: 1 };
    await writeFile(path, JSON.stringify(old));

    const manifest = await readManifest(path);

    expect(manifest.kind).toBe("golden");
    expect(manifest.kind === "golden" ? manifest.notices : "not golden").toBeUndefined();
  });
});

describe("manifestPathFor", () => {
  it("puts the manifest next to the image with a .json extension", () => {
    expect(manifestPathFor(join("images", "golden-2026-abc.qcow2"))).toBe(join("images", "golden-2026-abc.json"));
    expect(manifestPathFor(join("images", "runtime-1.2.3.iso"))).toBe(join("images", "runtime-1.2.3.json"));
  });
});

describe("verifyImage", () => {
  const bytes = Buffer.from("iso bytes");

  it("accepts an image that matches its manifest", async () => {
    const image = join(dir, "runtime-v1.iso");
    await writeFile(image, bytes);
    await chmod(image, 0o444);
    await writeManifest(manifestPathFor(image), runtimeManifest("runtime-v1.iso", bytes));
    const check = await verifyImage(image);
    expect(check).toMatchObject({ ok: true, manifest: { kind: "runtime", version: "v1" } });
    expect(await readManifest(manifestPathFor(image))).toEqual(runtimeManifest("runtime-v1.iso", bytes));
  });

  it("names the problem and the fix for a missing image, a missing manifest and changed bytes", async () => {
    const image = join(dir, "runtime-v1.iso");
    expect(await verifyImage(image)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/), fix: "invisible-dots image build" });

    await writeFile(image, bytes);
    expect(await verifyImage(image)).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot read the manifest/) });

    await writeManifest(manifestPathFor(image), runtimeManifest("runtime-v1.iso", bytes));
    await writeFile(image, "iso bytez");
    expect(await verifyImage(image)).toMatchObject({ ok: false, reason: expect.stringMatching(/hashes to .* its manifest says/), fix: expect.stringMatching(/^delete it/) });

    await writeFile(image, "longer iso bytes");
    expect(await verifyImage(image)).toMatchObject({ ok: false, reason: expect.stringMatching(/its manifest says 9/) });
  });

  it("refuses a manifest that describes another file", async () => {
    const image = join(dir, "runtime-v2.iso");
    await writeFile(image, bytes);
    await writeManifest(manifestPathFor(image), runtimeManifest("runtime-v1.iso", bytes));
    expect(await verifyImage(image)).toMatchObject({ ok: false, reason: expect.stringMatching(/describes runtime-v1\.iso/) });
  });
});
