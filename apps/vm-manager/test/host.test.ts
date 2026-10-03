import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accelerator,
  findQemu,
  isSupportedQemuVersion,
  MIN_QEMU_VERSION_TEXT,
  parseQemuVersion,
  QemuNotFoundError,
  qemuSearchDirs,
  officialQemuDir,
  OFFICIAL_QEMU_SUBDIR,
} from "../src/index.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

describe("accelerator", () => {
  it("is KVM on Linux and WHPX on Windows", () => {
    expect(accelerator("linux")).toBe("kvm");
    expect(accelerator("win32")).toBe("whpx");
  });

  it("refuses other hosts instead of falling back to emulation", () => {
    expect(() => accelerator("darwin")).toThrow(/does not run on darwin/);
    expect(() => accelerator("freebsd")).toThrow(/invisible-dots setup/);
  });

  it("answers for the host the tests run on", () => {
    if (process.platform === "linux" || process.platform === "win32") expect(["kvm", "whpx"]).toContain(accelerator());
  });
});

describe("qemuSearchDirs", () => {
  const abs = (name: string) => resolve(tmpdir(), name);

  it("searches INVISIBLE_DOTS_QEMU_DIR alone when it is set, as doctor says", () => {
    expect(qemuSearchDirs({ INVISIBLE_DOTS_QEMU_DIR: abs("q"), PATH: [abs("a"), abs("b")].join(delimiter), ProgramW6432: abs("pf") })).toEqual([abs("q")]);
  });

  it("searches the official installer's directory before PATH, from the variable Windows sets", () => {
    // An older QEMU on PATH must not shadow the one setup just installed.
    const dirs = qemuSearchDirs({ ProgramW6432: abs("pf"), PATH: [abs("a"), abs("b")].join(delimiter) });
    expect(dirs).toEqual([join(abs("pf"), "qemu"), abs("a"), abs("b")]);
    // Program Files on another drive, and a 32-bit view of the variables, are followed too.
    expect(officialQemuDir({ ProgramFiles: abs("d-pf") })).toBe(join(abs("d-pf"), "qemu"));
    // Linux has neither variable: no such directory, and no platform check.
    expect(officialQemuDir({})).toBeUndefined();
    expect(qemuSearchDirs({ PATH: abs("a") })).toEqual([abs("a")]);
  });

  it("drops relative and duplicate entries and strips quotes", () => {
    const dirs = qemuSearchDirs({ PATH: ["bin", abs("a"), `"${abs("b")}"`, abs("a"), ""].join(delimiter) });
    expect(dirs.slice(0, 2)).toEqual([abs("a"), abs("b")]);
  });

  it("reads the Windows spelling of PATH", () => {
    expect(qemuSearchDirs({ Path: abs("w") })[0]).toBe(abs("w"));
  });
});

describe("findQemu", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "idots-qemu-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fakeExists = (present: string[]) => async (path: string) => present.includes(path);

  it("finds both binaries, with or without .exe, in the first directory that has them", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const found = await findQemu(
      { PATH: [a, b].join(delimiter) },
      fakeExists([join(b, "qemu-system-x86_64.exe"), join(b, "qemu-img.exe"), join(a, "qemu-img")]),
    );
    expect(found).toEqual({ system: join(b, "qemu-system-x86_64.exe"), img: join(a, "qemu-img") });
  });

  it("uses only INVISIBLE_DOTS_QEMU_DIR when it is set", async () => {
    const configured = join(dir, "c");
    const onPath = join(dir, "p");
    await expect(
      findQemu({ INVISIBLE_DOTS_QEMU_DIR: configured, PATH: onPath }, fakeExists([join(configured, "qemu-system-x86_64"), join(onPath, "qemu-img")])),
    ).rejects.toThrow(/qemu-img was not found/);
  });

  it("names setup, doctor and the directories it searched", async () => {
    const error = (await findQemu({ PATH: dir }, fakeExists([])).catch((e: unknown) => e)) as QemuNotFoundError;
    expect(error).toBeInstanceOf(QemuNotFoundError);
    expect(error.searched[0]).toBe(dir);
    expect(error.message).toContain("invisible-dots setup");
    expect(error.message).toContain("invisible-dots doctor");
    expect(error.message).toContain("INVISIBLE_DOTS_QEMU_DIR");
  });

  it("refuses a relative INVISIBLE_DOTS_QEMU_DIR", async () => {
    await expect(findQemu({ INVISIBLE_DOTS_QEMU_DIR: "qemu" }, fakeExists([]))).rejects.toThrow(/not an absolute path/);
  });

  it("checks real files by default", async () => {
    await mkdir(join(dir, "bin"));
    for (const name of ["qemu-system-x86_64", "qemu-img"]) await writeFile(join(dir, "bin", name), "", { mode: 0o755 });
    expect(await findQemu({ INVISIBLE_DOTS_QEMU_DIR: join(dir, "bin") })).toEqual({
      system: join(dir, "bin", "qemu-system-x86_64"),
      img: join(dir, "bin", "qemu-img"),
    });
  });
});

describe("QEMU version", () => {
  it("parses both binaries' --version output", () => {
    expect(parseQemuVersion("QEMU emulator version 11.1.0 (v11.1.0-12130-ge470268ff4)\nCopyright")).toEqual({ major: 11, minor: 1, micro: 0 });
    expect(parseQemuVersion("qemu-img version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1)")).toEqual({ major: 8, minor: 2, micro: 2 });
    expect(parseQemuVersion("nothing here")).toBeUndefined();
  });

  it("supports 8.2 (Ubuntu 24.04's package) and newer", () => {
    expect(MIN_QEMU_VERSION_TEXT).toBe("8.2");
    expect(isSupportedQemuVersion({ major: 8, minor: 2, micro: 0 })).toBe(true);
    expect(isSupportedQemuVersion({ major: 8, minor: 2, micro: 2 })).toBe(true);
    expect(isSupportedQemuVersion({ major: 10, minor: 0, micro: 0 })).toBe(true);
    expect(isSupportedQemuVersion({ major: 8, minor: 1, micro: 9 })).toBe(false);
    expect(isSupportedQemuVersion({ major: 7, minor: 2, micro: 0 })).toBe(false);
  });
});

describe("the pinned Windows installer", () => {
  const pin = JSON.parse(readFileSync(join(repo, "virtualization/qemu/windows.json"), "utf8"));

  it("records version, URL and both hashes of one official build", () => {
    expect(pin.url).toBe(`https://qemu.weilnetz.de/w64/${pin.build.slice(0, 4)}/qemu-w64-setup-${pin.build}.exe`);
    expect(pin.sha512_url).toBe(pin.url.replace(/\.exe$/, ".sha512"));
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.sha512).toMatch(/^[0-9a-f]{128}$/);
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(isSupportedQemuVersion(parseQemuVersion(`version ${pin.version}`)!)).toBe(true);
    expect(pin.silent_args).toEqual(["/S"]);
  });

  it("installs where the vm-manager looks", () => {
    expect(pin.install_subdir).toBe(OFFICIAL_QEMU_SUBDIR);
  });
});
