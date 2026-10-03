import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV, hostPaths, imageFileName, imageLabel, imageVersionOf } from "../src/index.js";

// Expected values are built with node:path so the same assertions hold on
// Linux ("/") and Windows ("\"): the layout is what is tested, not the separator.
const userHome = resolve("fake-user-home");
const home = join(userHome, ".invisible-dots");
const dotId = "dot_01k6h3w2ze8m4qv7r1xk9bntc5";

describe("hostPaths", () => {
  it("lays out section 3.2 under ~/.invisible-dots by default", () => {
    const paths = hostPaths({}, userHome);
    const vm = join(home, "vms", dotId);
    expect(paths.home).toBe(home);
    expect(paths.configDir).toBe(join(home, "config"));
    expect(paths.masterKeyPath).toBe(join(home, "config", "master.key"));
    expect(paths.apiTokenPath).toBe(join(home, "config", "api.token"));
    expect(paths.dbDir).toBe(join(home, "db"));
    expect(paths.serverLockPath).toBe(join(home, "server.lock"));
    expect(paths.imagesDir).toBe(join(home, "images"));
    expect(paths.baseImagePath("noble-server-cloudimg-amd64.img")).toBe(join(home, "images", "noble-server-cloudimg-amd64.img"));
    expect(paths.goldenImagePath("3")).toBe(join(home, "images", "golden-3.qcow2"));
    expect(paths.runtimeIsoPath("0.1.0")).toBe(join(home, "images", "runtime-0.1.0.iso"));
    expect(paths.vmsDir).toBe(join(home, "vms"));
    expect(paths.vmDir(dotId)).toBe(vm);
    expect(paths.diskPath(dotId)).toBe(join(vm, "disk.qcow2"));
    expect(paths.seedPath(dotId)).toBe(join(vm, "seed.iso"));
    expect(paths.processFilePath(dotId)).toBe(join(vm, "qemu.json"));
    expect(paths.serialLogPath(dotId)).toBe(join(vm, "serial.log"));
    expect(paths.logsDir).toBe(join(home, "logs"));
    expect(paths.qemuLogPath(dotId)).toBe(join(home, "logs", `qemu-${dotId}.log`));
  });

  it("uses INVISIBLE_DOTS_HOME, made absolute", () => {
    const custom = resolve("custom-dots-home");
    expect(hostPaths({ [ENV.HOME]: custom }, userHome).diskPath("d1")).toBe(join(custom, "vms", "d1", "disk.qcow2"));
    expect(hostPaths({ [ENV.HOME]: "relative-home" }, userHome).home).toBe(resolve("relative-home"));
    // Blank means unset, so a stray empty variable does not put the data in the current directory.
    expect(hostPaths({ [ENV.HOME]: "  " }, userHome).home).toBe(home);
  });

  it("defaults to the real home directory", () => {
    expect(hostPaths({}).home.endsWith(".invisible-dots")).toBe(true);
  });

  it("refuses ids and versions that are not one plain path segment", () => {
    const paths = hostPaths({}, userHome);
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "-x", "dot id"]) {
      expect(() => paths.vmDir(bad)).toThrow(/invalid dot id/);
    }
    expect(() => paths.goldenImagePath("../1")).toThrow(/invalid image version/);
    expect(() => paths.runtimeIsoPath("1/2")).toThrow(/invalid image version/);
    expect(() => paths.baseImagePath("..")).toThrow(/invalid image file name/);
  });

  it("puts no length limit on a VM's paths: nothing under the home is a unix socket", () => {
    const deep = join(userHome, "x".repeat(200));
    const paths = hostPaths({ [ENV.HOME]: deep }, userHome);
    expect(paths.processFilePath(dotId)).toBe(join(deep, "vms", dotId, "qemu.json"));
  });
});

describe("image file names", () => {
  it("name and parse the two built images the same way", () => {
    expect(imageFileName("golden", "20261002120000-abcdef012345")).toBe("golden-20261002120000-abcdef012345.qcow2");
    expect(imageFileName("runtime", "1.10")).toBe("runtime-1.10.iso");
    expect(imageVersionOf("golden", "golden-20261002120000-abcdef012345.qcow2")).toBe("20261002120000-abcdef012345");
    expect(imageVersionOf("runtime", "runtime-1.10.iso")).toBe("1.10");
    expect(imageLabel("runtime")).toBe("runtime ISO");
  });

  it("ignore every other file of the images directory", () => {
    for (const name of ["golden-1.json", "runtime-1.json", "golden-.qcow2", ".golden-1.work", "noble-server-cloudimg-amd64.img", "runtime-1.iso.tmp"]) {
      expect(imageVersionOf("golden", name)).toBeUndefined();
      expect(imageVersionOf("runtime", name)).toBeUndefined();
    }
    expect(imageVersionOf("golden", "runtime-1.iso")).toBeUndefined();
  });
});
