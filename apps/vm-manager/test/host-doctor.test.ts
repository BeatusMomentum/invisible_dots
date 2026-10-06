import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freeSpace, hostDoctorDeps, locateQemu } from "../src/index.js";
import { ok } from "./doctor-fakes.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-doctor-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function program(name: string): Promise<string> {
  const path = join(dir, "qemu", name);
  await mkdir(join(dir, "qemu"), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
  return path;
}

describe("locateQemu", () => {
  it("finds each program separately, so a missing qemu-img still leaves qemu-system to be checked", async () => {
    const system = await program("qemu-system-x86_64");
    const env = { INVISIBLE_DOTS_QEMU_DIR: join(dir, "qemu") };
    expect(await locateQemu(env)).toEqual({ system, searched: [join(dir, "qemu")], configured: true });

    const img = await program("qemu-img");
    expect(await locateQemu(env)).toEqual({ system, img, searched: [join(dir, "qemu")], configured: true });
  });

  it("names the places searched when nothing is found, and says whether INVISIBLE_DOTS_QEMU_DIR was the only one", async () => {
    expect(await locateQemu({ INVISIBLE_DOTS_QEMU_DIR: join(dir, "nothing") })).toEqual({ searched: [join(dir, "nothing")], configured: true });
    expect(await locateQemu({ PATH: join(dir, "bin"), ProgramFiles: "", ProgramW6432: "" })).toEqual({ searched: [join(dir, "bin")], configured: false });
  });
});

describe("freeSpace", () => {
  it("measures the nearest directory that exists, since doctor creates nothing", async () => {
    const home = join(dir, "not", "yet", "created");
    const space = await freeSpace(home);
    expect(space.path).toBe(dir);
    expect(space.bytes).toBeGreaterThan(0);
  });
});

describe("hostDoctorDeps", () => {
  it("hands the caller's home, images and key to the report and reads the rest from this machine", async () => {
    const deps = hostDoctorDeps({
      env: { INVISIBLE_DOTS_QEMU_DIR: join(dir, "nothing") },
      home: dir,
      images: async () => [ok("golden-image", "golden image")],
      openRouterKey: async () => ok("openrouter", "OpenRouter key"),
    });
    expect(deps.nodeVersion).toBe(process.versions.node);
    expect(deps.home).toBe(dir);
    expect((await deps.freeSpace()).path).toBe(dir);
    expect(await deps.findQemu()).toMatchObject({ searched: [join(dir, "nothing")], configured: true });
    expect((await deps.images())[0]?.id).toBe("golden-image");
    expect((await deps.openRouterKey()).status).toBe("ok");
  });
});
