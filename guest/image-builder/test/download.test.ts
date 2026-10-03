import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksumFromSums, DownloadError, fetchVerified, sha256File } from "../src/download.js";
import { sha256, startFakeHttp, type FakeHttp } from "./http-fixture.js";

const IMAGE = Buffer.from("pretend this is a 600 MiB cloud image\n".repeat(5000));
const IMAGE_SHA = sha256(IMAGE);

let http: FakeHttp;
let dir: string;

beforeEach(async () => {
  http = await startFakeHttp({
    "/release/image.img": { body: IMAGE },
    "/release/SHA256SUMS": { body: `${"0".repeat(64)} *other.img\n${IMAGE_SHA} *image.img\n` },
  });
  dir = await mkdtemp(join(tmpdir(), "idots-download-"));
});

afterEach(async () => {
  await http.close();
  await rm(dir, { recursive: true, force: true });
});

const fast = { attempts: 2, retryDelayMs: 0, idleTimeoutMs: 2000 };

describe("checksumFromSums", () => {
  it("reads text and binary mode lines and ignores everything else", () => {
    const sums = [
      `${"a".repeat(64)}  node-v24.21.0-linux-x64.tar.xz`,
      `${"B".repeat(64)} *ubuntu.img`,
      "not a checksum line",
      `${"c".repeat(64)}  node-v24.21.0-linux-x64.tar.xz.extra`,
    ].join("\r\n");
    expect(checksumFromSums(sums, "node-v24.21.0-linux-x64.tar.xz")).toBe("a".repeat(64));
    expect(checksumFromSums(sums, "ubuntu.img")).toBe("b".repeat(64));
    expect(checksumFromSums(sums, "missing")).toBeUndefined();
  });
});

describe("fetchVerified", () => {
  it("downloads, checks the published list and the hash, and leaves only the final file", async () => {
    const dest = join(dir, "cache", "image.img");
    const result = await fetchVerified(
      { url: http.url("/release/image.img"), sha256: IMAGE_SHA, sumsUrl: http.url("/release/SHA256SUMS"), sumsEntry: "image.img" },
      dest,
      fast,
    );
    expect(result).toEqual({ path: dest, cached: false, bytes: IMAGE.length });
    expect(await sha256File(dest)).toBe(IMAGE_SHA);
    expect(await readdir(join(dir, "cache"))).toEqual(["image.img"]);
    // The list is read before the image, so a disagreement costs no transfer.
    expect(http.requests).toEqual(["/release/SHA256SUMS", "/release/image.img"]);
  });

  it("refuses before downloading when the published list disagrees with the pin", async () => {
    const wrongPin = "1".repeat(64);
    await expect(
      fetchVerified({ url: http.url("/release/image.img"), sha256: wrongPin, sumsUrl: http.url("/release/SHA256SUMS"), sumsEntry: "image.img" }, join(dir, "x.img"), fast),
    ).rejects.toThrow(/lists [0-9a-f]{64} for image\.img but the pin is 1{64}: refusing/);
    expect(http.requests).toEqual(["/release/SHA256SUMS"]);
  });

  it("refuses when the published list has no line for the file", async () => {
    await expect(
      fetchVerified({ url: http.url("/release/image.img"), sha256: IMAGE_SHA, sumsUrl: http.url("/release/SHA256SUMS"), sumsEntry: "renamed.img" }, join(dir, "x.img"), fast),
    ).rejects.toThrow(/has no line for renamed\.img/);
  });

  it("deletes a download whose bytes do not match the pin", async () => {
    http.set("/release/image.img", { body: Buffer.concat([IMAGE, Buffer.from("tampered")]) });
    const dest = join(dir, "image.img");
    const error = await fetchVerified({ url: http.url("/release/image.img"), sha256: IMAGE_SHA }, dest, fast).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as Error).message).toMatch(/hashes to [0-9a-f]{64}, but the pin is/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("trusts a cached copy only after re-hashing it", async () => {
    const dest = join(dir, "image.img");
    await writeFile(dest, IMAGE);
    expect(await fetchVerified({ url: http.url("/release/image.img"), sha256: IMAGE_SHA }, dest, fast)).toMatchObject({ cached: true });
    expect(http.requests).toEqual([]);

    await writeFile(dest, "truncated");
    expect(await fetchVerified({ url: http.url("/release/image.img"), sha256: IMAGE_SHA }, dest, fast)).toMatchObject({ cached: false });
    expect(await readFile(dest)).toEqual(IMAGE);
  });

  it("follows redirects, as GitHub release downloads need", async () => {
    http.set("/download/uv.tar.gz", { redirect: "/objects/blob" });
    http.set("/objects/blob", { body: IMAGE });
    await fetchVerified({ url: http.url("/download/uv.tar.gz"), sha256: IMAGE_SHA }, join(dir, "uv.tar.gz"), fast);
    expect(http.requests).toEqual(["/download/uv.tar.gz", "/objects/blob"]);
  });

  it("does not retry a 404", async () => {
    await expect(fetchVerified({ url: http.url("/gone.img"), sha256: IMAGE_SHA }, join(dir, "gone.img"), fast)).rejects.toThrow(/HTTP 404/);
    expect(http.requests).toEqual(["/gone.img"]);
  });

  it("retries a 5xx and gives up after the last attempt", async () => {
    http.set("/flaky.img", { body: "busy", status: 503 });
    await expect(fetchVerified({ url: http.url("/flaky.img"), sha256: IMAGE_SHA }, join(dir, "flaky.img"), fast)).rejects.toThrow(/HTTP 503/);
    expect(http.requests).toEqual(["/flaky.img", "/flaky.img"]);
  });

  it("aborts a transfer that stops sending, and removes the partial file", async () => {
    http.set("/stall.img", { stallAfter: IMAGE.subarray(0, 1000) });
    await expect(
      fetchVerified({ url: http.url("/stall.img"), sha256: IMAGE_SHA }, join(dir, "stall.img"), { attempts: 1, idleTimeoutMs: 200 }),
    ).rejects.toThrow(/no data for 200 ms/);
    expect(await readdir(dir)).toEqual([]);
  });
});
