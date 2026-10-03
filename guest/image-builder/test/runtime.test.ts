import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPaths, type HostPaths } from "@invisible-dots/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The ISO package's own test reader: it shares no code with the writer.
import { fileBytes, listFiles, parseIso } from "../../../packages/iso/test/iso-reader.js";
import { defaultAssetRoot, GUEST_UNITS } from "../src/assets.js";
import { readManifest, verifyImage, type RuntimeManifest } from "../src/manifest.js";
import { RUNTIME_ISO_LABEL } from "@invisible-dots/vm-manager";
import { assertLinuxAmd64Elf, buildRuntimeIso, type RuntimeInputs } from "../src/runtime.js";
import { sha256 } from "./http-fixture.js";

/** The first bytes of an ELF executable for `machine` (0x3e is x86-64, 0xb7 arm64). */
function elf(machine: number, body = "go binary"): Buffer {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  header.writeUInt16LE(2, 16);
  header.writeUInt16LE(machine, 18);
  return Buffer.concat([header, Buffer.from(body)]);
}

let dir: string;
let paths: HostPaths;
let inputs: RuntimeInputs;
const AGENT = "#!/usr/bin/env node\nconsole.log('the agent');\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-runtime-"));
  paths = hostPaths({ INVISIBLE_DOTS_HOME: join(dir, "home") });
  inputs = { agentBundle: join(dir, "invisible-dots-agent.mjs"), agentdBinary: join(dir, "dot-agentd") };
  await writeFile(inputs.agentBundle, AGENT);
  await writeFile(inputs.agentdBinary, elf(0x3e));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const at = (iso: string) => new Date(`2026-10-02T${iso}Z`);

describe("buildRuntimeIso", () => {
  it("writes the IDOTS-RT disk with the agent, dot-agentd, the hook and the units", async () => {
    const result = await buildRuntimeIso({ inputs, paths, now: () => at("08:00:00") });
    expect(result.created).toBe(true);
    expect(result.version).toMatch(/^20261002080000-[0-9a-f]{12}$/);
    expect(result.iso).toBe(paths.runtimeIsoPath(result.version));
    expect((await stat(result.iso)).mode & 0o222).toBe(0);

    const image = await readFile(result.iso);
    const parsed = parseIso(image);
    // The label the Dot seed mounts (vm-manager seed.ts): the two meet in one constant.
    expect(parsed.primary.volumeId).toBe(RUNTIME_ISO_LABEL);
    expect(parsed.joliet.volumeId).toBe(RUNTIME_ISO_LABEL);
    const files = listFiles(parsed.joliet.root);
    expect([...files.keys()].sort()).toEqual(
      ["VERSION", "bin/dot-agentd", "bin/dot-desktop", "install.sh", "invisible-dots-agent.mjs", ...GUEST_UNITS.map((unit) => `units/${unit}`)].sort(),
    );
    const read = (path: string) => fileBytes(image, files.get(path)!);
    expect(read("VERSION").toString()).toBe(`${result.version}\n`);
    expect(read("invisible-dots-agent.mjs").toString()).toBe(AGENT);
    expect(read("bin/dot-agentd")).toEqual(elf(0x3e));
    expect(read("install.sh")).toEqual(await readFile(join(defaultAssetRoot(), "runtime", "install.sh")));
    expect(read("bin/dot-desktop")).toEqual(await readFile(join(defaultAssetRoot(), "runtime", "dot-desktop.sh")));
    expect(read("units/dot-agentd.service")).toEqual(await readFile(join(defaultAssetRoot(), "units", "dot-agentd.service")));

    const manifest = (await readManifest(result.manifest)) as RuntimeManifest;
    expect(manifest).toMatchObject({ kind: "runtime", version: result.version, file: `runtime-${result.version}.iso`, sha256: sha256(image), size_bytes: image.length });
    expect(manifest.files.find((file) => file.path === "bin/dot-agentd")).toEqual({ path: "bin/dot-agentd", sha256: sha256(elf(0x3e)), size_bytes: elf(0x3e).length });
    expect(result.version.endsWith(manifest.content_digest)).toBe(true);
    expect(await verifyImage(result.iso)).toMatchObject({ ok: true });
  });

  it("does nothing for code it already packed, and makes a newer version for new code", async () => {
    const first = await buildRuntimeIso({ inputs, paths, now: () => at("08:00:00") });
    const again = await buildRuntimeIso({ inputs, paths, now: () => at("09:00:00") });
    expect(again).toEqual({ ...first, created: false });

    await writeFile(inputs.agentBundle, `${AGENT}// changed\n`);
    const next = await buildRuntimeIso({ inputs, paths, now: () => at("10:00:00") });
    expect(next.created).toBe(true);
    // The control plane starts VMs with the highest version: the new code must sort last.
    expect([next.version, first.version].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1)).toBe(next.version);
  });

  it("uses an explicit version as given", async () => {
    const result = await buildRuntimeIso({ inputs, paths, version: "1.2.3" });
    expect(result.iso).toBe(paths.runtimeIsoPath("1.2.3"));
    await expect(buildRuntimeIso({ inputs, paths, version: "../x" })).rejects.toThrow(/invalid image version/);
  });

  it("names the build command for a missing input", async () => {
    await rm(inputs.agentBundle);
    await expect(buildRuntimeIso({ inputs, paths })).rejects.toThrow(/npm run build --workspace guest\/invisible-dots-agent/);
    await writeFile(inputs.agentBundle, AGENT);
    await rm(inputs.agentdBinary);
    await expect(buildRuntimeIso({ inputs, paths })).rejects.toThrow(/GOOS=linux GOARCH=amd64 go build/);
  });

  it("refuses a guest file with CRLF line endings", async () => {
    const assetRoot = join(dir, "assets");
    await cp(defaultAssetRoot(), assetRoot, { recursive: true, filter: (source) => !source.includes("node_modules") });
    const unit = join(assetRoot, "units", "dot-agentd.service");
    await writeFile(unit, (await readFile(unit, "utf8")).replaceAll("\n", "\r\n"));
    await expect(buildRuntimeIso({ inputs, paths, assetRoot })).rejects.toThrow(/dot-agentd\.service has CR line endings/);
  });
});

describe("assertLinuxAmd64Elf", () => {
  it("accepts linux/amd64 and refuses other builds of dot-agentd", async () => {
    const path = join(dir, "bin");
    await writeFile(path, elf(0x3e));
    await expect(assertLinuxAmd64Elf(path)).resolves.toBeUndefined();
    await writeFile(path, elf(0xb7));
    await expect(assertLinuxAmd64Elf(path)).rejects.toThrow(/not a linux\/amd64 executable/);
    await writeFile(path, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100)]));
    await expect(assertLinuxAmd64Elf(path)).rejects.toThrow(/not a linux\/amd64 executable/);
    await writeFile(path, "");
    await expect(assertLinuxAmd64Elf(path)).rejects.toThrow(/not a linux\/amd64 executable/);
  });
});
