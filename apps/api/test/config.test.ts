import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPaths, type HostPaths } from "@invisible-dots/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireServerLock,
  loadOrCreateApiToken,
  loadOrGenerateMasterKey,
  parseListen,
  saveMasterKey,
} from "../src/index.js";

let dir: string;
let paths: HostPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-config-"));
  paths = hostPaths({ INVISIBLE_DOTS_HOME: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("server settings", () => {
  it("parses the listen address", () => {
    expect(parseListen()).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(parseListen("0.0.0.0:9000")).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(parseListen("[::1]:8787")).toEqual({ host: "::1", port: 8787 });
    expect(parseListen("8080")).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(() => parseListen("localhost:http")).toThrow(/INVISIBLE_DOTS_LISTEN/);
  });

  it("creates the API token once and reads it back; the environment wins; short tokens are refused", async () => {
    const created = await loadOrCreateApiToken(paths, {});
    expect(created).toMatchObject({ created: true, origin: paths.apiTokenPath });
    expect(created.value).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadOrCreateApiToken(paths, {})).toEqual({ ...created, created: false });

    expect(await loadOrCreateApiToken(paths, { INVISIBLE_DOTS_TOKEN: "x".repeat(32) })).toMatchObject({
      value: "x".repeat(32),
      origin: "INVISIBLE_DOTS_TOKEN",
    });
    await expect(loadOrCreateApiToken(paths, { INVISIBLE_DOTS_TOKEN: "short" })).rejects.toThrow(/shorter/);
    await writeFile(paths.apiTokenPath, "tiny\r\n");
    await expect(loadOrCreateApiToken(paths, {})).rejects.toThrow(/shorter/);
  });

  it("generates a master key without writing it; saves it on request; accepts raw or hex keys, refuses others", async () => {
    const generated = await loadOrGenerateMasterKey(paths);
    expect(generated.created).toBe(true);
    expect(generated.value.length).toBe(32);
    await expect(readFile(paths.masterKeyPath)).rejects.toMatchObject({ code: "ENOENT" });

    await saveMasterKey(paths, generated.value);
    expect(await loadOrGenerateMasterKey(paths)).toEqual({ value: generated.value, origin: paths.masterKeyPath, created: false });

    await writeFile(paths.masterKeyPath, `${"ab".repeat(32)}\n`);
    expect((await loadOrGenerateMasterKey(paths)).value).toEqual(Buffer.from("ab".repeat(32), "hex"));
    await writeFile(paths.masterKeyPath, "not a key");
    await expect(loadOrGenerateMasterKey(paths)).rejects.toThrow(/must hold 32 bytes/);
  });
});

describe("server lock", () => {
  it("is exclusive while held, released on release, and taken over from a dead pid", async () => {
    const lock = await acquireServerLock(paths);
    expect(JSON.parse(await readFile(paths.serverLockPath, "utf8"))).toMatchObject({ pid: process.pid });
    await expect(acquireServerLock(paths)).rejects.toThrow(/already holds/);
    await lock.release();
    await expect(readFile(paths.serverLockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(paths.serverLockPath, "4242\n");
    await expect(acquireServerLock(paths, () => "ours")).rejects.toThrow(/pid 4242.*remove .*server\.lock/);
    const taken = await acquireServerLock(paths, () => "gone");
    expect(JSON.parse(await readFile(paths.serverLockPath, "utf8"))).toMatchObject({ pid: process.pid });
    await taken.release();
  });

  it("release leaves a lock that another server took over in place", async () => {
    const lock = await acquireServerLock(paths);
    await writeFile(paths.serverLockPath, "4242\n");
    await lock.release();
    expect(await readFile(paths.serverLockPath, "utf8")).toBe("4242\n");
  });
});
