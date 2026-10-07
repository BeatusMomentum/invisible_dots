import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { installerFileName, parseWindowsQemuPin } from "../src/setup/qemu-pin.js";

describe("Windows QEMU pin", () => {
  const good = { version: "10.0.0", url: "https://qemu.weilnetz.de/w64/2025/qemu-w64-setup-20250422.exe", sha256: "AB".repeat(32), silent_args: ["/S"] };

  it("accepts a version, an https URL and a SHA-256, and normalises the hash", () => {
    expect(parseWindowsQemuPin(good)).toEqual({ version: good.version, url: good.url, sha256: "ab".repeat(32), silentArgs: ["/S"] });
  });

  it("accepts the pin file in this repository", async () => {
    const pin = parseWindowsQemuPin(JSON.parse(await readFile(new URL("../../../virtualization/qemu/windows.json", import.meta.url), "utf8")));
    expect(pin.url.startsWith("https://")).toBe(true);
    expect(installerFileName(pin)).toMatch(/\.exe$/);
  });

  it("refuses a pin without its silent switch", () => {
    expect(() => parseWindowsQemuPin({ ...good, silent_args: [] })).toThrow(/"silent_args" must be a non-empty list/);
    expect(() => parseWindowsQemuPin({ ...good, silent_args: undefined })).toThrow(/silent_args/);
  });

  it("refuses anything that would make setup download the wrong bytes", () => {
    expect(() => parseWindowsQemuPin(null)).toThrow(/expected a JSON object/);
    expect(() => parseWindowsQemuPin({ ...good, url: "http://qemu.weilnetz.de/x.exe" })).toThrow(/must use https/);
    expect(() => parseWindowsQemuPin({ ...good, sha256: "abc" })).toThrow(/64 hexadecimal/);
    expect(() => parseWindowsQemuPin({ ...good, version: "" })).toThrow(/"version" must be a non-empty string/);
    expect(() => parseWindowsQemuPin({ ...good, version: "latest" })).toThrow(/major\.minor/);
    expect(() => parseWindowsQemuPin({ ...good, url: "not a url" })).toThrow(/not a URL/);
  });

  it("saves the installer under its own plain name, or a fixed one", () => {
    expect(installerFileName(parseWindowsQemuPin(good))).toBe("qemu-w64-setup-20250422.exe");
    expect(installerFileName(parseWindowsQemuPin({ ...good, url: "https://example.org/download?id=7" }))).toBe("qemu-10.0.0-setup.exe");
    expect(installerFileName(parseWindowsQemuPin({ ...good, url: "https://example.org/a%27b.exe" }))).toBe("qemu-10.0.0-setup.exe");
  });
});
