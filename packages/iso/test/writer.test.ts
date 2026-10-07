import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entriesFromDirectory, IsoError, writeIso, type IsoEntry } from "../src/index.js";
import { fileBytes, listDirectories, listFiles, parseIso, type ParsedIso } from "./iso-reader.js";

const FIXED = new Date("2026-01-02T03:04:05.670Z");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-iso-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function build(entries: IsoEntry[], volumeId = "TEST", name = "out.iso"): Promise<{ image: Buffer; iso: ParsedIso; path: string }> {
  const path = join(dir, name);
  const summary = await writeIso(path, entries, { volumeId, timestamp: FIXED });
  const image = await readFile(path);
  expect(image.length).toBe(summary.bytes);
  expect(summary.sectors * 2048).toBe(summary.bytes);
  return { image, iso: parseIso(image), path };
}

describe("writeIso", () => {
  it("writes a cloud-init NoCloud seed", async () => {
    const userData = "#cloud-config\nwrite_files:\n  - path: /etc/invisible-dots/config.json\n";
    const metaData = "instance-id: dot_test\nlocal-hostname: dot-test\n";
    const { image, iso } = await build(
      [
        { path: "user-data", data: userData },
        { path: "meta-data", data: Buffer.from(metaData) },
      ],
      "cidata",
    );

    expect(iso.primary.volumeId).toBe("cidata");
    expect(iso.joliet.volumeId).toBe("cidata");
    expect(iso.primary.applicationId).toBe("INVISIBLE_DOTS");
    expect(iso.joliet.applicationId).toBe("INVISIBLE_DOTS");
    expect(iso.primary.creationDate.slice(0, 16)).toBe("2026010203040567");

    const joliet = listFiles(iso.joliet.root);
    expect([...joliet.keys()]).toEqual(["meta-data", "user-data"]);
    expect(fileBytes(image, joliet.get("user-data")!).toString("utf8")).toBe(userData);
    expect(fileBytes(image, joliet.get("meta-data")!).toString("utf8")).toBe(metaData);

    // The primary tree has 8.3 names and points at the very same data.
    const primary = listFiles(iso.primary.root);
    expect([...primary.keys()]).toEqual(["META_DAT.;1", "USER_DAT.;1"]);
    expect(primary.get("USER_DAT.;1")!.lba).toBe(joliet.get("user-data")!.lba);
    expect(primary.get("META_DAT.;1")!.size).toBe(Buffer.byteLength(metaData));
  });

  it("writes nested trees from buffers and streamed host files, keeping long names", async () => {
    // Bigger than the 1 MiB copy chunk and not a whole number of sectors.
    const binary = randomBytes(3 * 1024 * 1024 + 123);
    const binaryPath = join(dir, "dot-agentd");
    await writeFile(binaryPath, binary);
    const longName = `${"a".repeat(60)}.txt`;
    const deep = "l1/l2/l3/l4/l5/l6/l7/leaf.txt";
    // "resume" with two e-acute and two CJK ideographs, built from code points to keep the source ASCII.
    const eAcute = String.fromCharCode(0xe9);
    const unicode = `r${eAcute}sum${eAcute} ${String.fromCharCode(0x4e2d, 0x6587)}.md`;
    const entries: IsoEntry[] = [
      { path: "bin/dot-agentd", file: binaryPath },
      { path: "/agent/invisible-dots-agent.mjs", data: "console.log('agent');\n" },
      { path: "systemd/invisible-dots-agent.service", data: "[Unit]\nDescription=agent\n" },
      { path: "systemd/invisible-dots-agentd.service", data: "[Unit]\nDescription=agentd\n" },
      { path: "systemd/dot-desktop.service", data: "[Unit]\n" },
      { path: "empty-file", data: new Uint8Array(0) },
      { path: "empty-dir", directory: true },
      { path: "docs", directory: true },
      { path: `docs/${longName}`, data: "long" },
      { path: `docs/${unicode}`, data: "unicode" },
      { path: deep, data: "deep" },
    ];
    const { image, iso } = await build(entries, "IDOTS-RT");

    expect(iso.joliet.volumeId).toBe("IDOTS-RT");
    expect(iso.primary.volumeId).toBe("IDOTS-RT");
    const files = listFiles(iso.joliet.root);
    expect([...files.keys()].sort()).toEqual(
      [
        "agent/invisible-dots-agent.mjs",
        "bin/dot-agentd",
        `docs/${longName}`,
        `docs/${unicode}`,
        "empty-file",
        deep,
        "systemd/dot-desktop.service",
        "systemd/invisible-dots-agent.service",
        "systemd/invisible-dots-agentd.service",
      ].sort(),
    );
    expect(fileBytes(image, files.get("bin/dot-agentd")!).equals(binary)).toBe(true);
    expect(fileBytes(image, files.get(deep)!).toString()).toBe("deep");
    expect(fileBytes(image, files.get(`docs/${unicode}`)!).toString()).toBe("unicode");
    expect(files.get("empty-file")!.size).toBe(0);
    expect(fileBytes(image, files.get("systemd/invisible-dots-agentd.service")!).toString()).toContain("agentd");
    expect(listDirectories(iso.joliet.root)).toContain("empty-dir");

    // Primary names: d-characters only, 8.3, unique per directory, same structure as Joliet.
    const primaryFiles = listFiles(iso.primary.root);
    expect(primaryFiles.size).toBe(files.size);
    for (const path of primaryFiles.keys()) {
      for (const part of path.split("/")) expect(part).toMatch(/^[A-Z0-9_]{1,8}(\.[A-Z0-9_]{0,3};1)?$/);
    }
    const systemd = [...primaryFiles.keys()].filter((p) => p.startsWith("SYSTEMD/")).sort();
    expect(systemd).toEqual(["SYSTEMD/DOT_DESK.SER;1", "SYSTEMD/INVISIB1.SER;1", "SYSTEMD/INVISIBL.SER;1"]);
    const toPrimary = (path: string) =>
      path
        .split("/")
        .map((part) => part.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 8))
        .join("/");
    expect(listDirectories(iso.primary.root).sort()).toEqual(listDirectories(iso.joliet.root).map(toPrimary).sort());
    expect(listDirectories(iso.primary.root)).toContain("EMPTY_DI");
  });

  it("is deterministic: same inputs in any order give the same bytes", async () => {
    const entries: IsoEntry[] = [
      { path: "b/two", data: "2" },
      { path: "a", data: "1" },
      { path: "b/one", data: "1" },
      { path: "c", directory: true },
    ];
    const first = await build(entries, "DET", "first.iso");
    const second = await build([...entries].reverse(), "DET", "second.iso");
    expect(first.image.equals(second.image)).toBe(true);

    const later = await writeIso(join(dir, "later.iso"), entries, { volumeId: "DET", timestamp: new Date("2027-01-01T00:00:00Z") });
    expect((await readFile(join(dir, "later.iso"))).equals(first.image)).toBe(false);
    expect(later.files).toBe(3);
    expect(later.directories).toBe(3);
  });

  it("spreads a large directory over several sectors without splitting a record", async () => {
    const entries: IsoEntry[] = [];
    for (let i = 0; i < 120; i++) entries.push({ path: `many/file-number-${String(i).padStart(3, "0")}-with-a-longer-name.json`, data: `{"i":${i}}` });
    const { image, iso } = await build(entries);
    const many = iso.joliet.root.children.find((c) => c.name === "many");
    expect(many?.kind).toBe("dir");
    expect(many!.size).toBeGreaterThan(2048 * 4);
    const files = listFiles(iso.joliet.root);
    expect(files.size).toBe(120);
    expect(fileBytes(image, files.get("many/file-number-077-with-a-longer-name.json")!).toString()).toBe('{"i":77}');
    expect(listFiles(iso.primary.root).size).toBe(120);
  });

  it("replaces an existing image and leaves no temporary files", async () => {
    const path = join(dir, "seed.iso");
    await writeIso(path, [{ path: "x", data: "old" }], { volumeId: "cidata", timestamp: FIXED });
    await writeIso(path, [{ path: "x", data: "new" }], { volumeId: "cidata", timestamp: FIXED });
    const image = await readFile(path);
    const iso = parseIso(image);
    expect(fileBytes(image, listFiles(iso.joliet.root).get("x")!).toString()).toBe("new");
    expect(await readdir(dir)).toEqual(["seed.iso"]);
  });

  it("writes an image with no entries at all", async () => {
    const { iso } = await build([]);
    expect(iso.joliet.root.children).toEqual([]);
    expect(iso.primary.pathTable).toHaveLength(1);
  });

  describe("refuses", () => {
    const cases: [string, IsoEntry[], string, RegExp][] = [
      ["an empty volume id", [], "", /volume identifier/],
      ["a volume id with a space", [], "my seed", /volume identifier/],
      ["a volume id over 16 characters", [], "A".repeat(17), /volume identifier/],
      ["an empty path component", [{ path: "a//b", data: "" }], "V", /empty path component/],
      ["a dot-dot component", [{ path: "a/../b", data: "" }], "V", /contains "\.\."/],
      ["a character Joliet forbids", [{ path: "a:b", data: "" }], "V", /does not allow/],
      ["a name over 64 characters", [{ path: "x".repeat(65), data: "" }], "V", /Joliet allows 64/],
      ["a character outside the BMP", [{ path: "smile-\u{1f600}", data: "" }], "V", /Basic Multilingual Plane/],
      ["a path 9 levels deep", [{ path: "1/2/3/4/5/6/7/8/9", data: "" }], "V", /at most 8/],
      ["a directory at level 9", [{ path: "1/2/3/4/5/6/7/8", directory: true }], "V", /level 9/],
      ["a path listed twice", [{ path: "a", data: "1" }, { path: "a", data: "2" }], "V", /listed twice/],
      ["a file where a directory is needed", [{ path: "a", data: "1" }, { path: "a/b", data: "2" }], "V", /is a file/],
      ["a file over a directory", [{ path: "a/b", data: "2" }, { path: "a", data: "1" }], "V", /already a directory/],
      ["an empty path", [{ path: "", data: "" }], "V", /empty path/],
    ];
    for (const [what, entries, volumeId, message] of cases) {
      it(what, async () => {
        const error = await writeIso(join(dir, "bad.iso"), entries, { volumeId, timestamp: FIXED }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(IsoError);
        expect((error as Error).message).toMatch(message);
        expect(await readdir(dir)).toEqual([]);
      });
    }

    it("a missing host file", async () => {
      const error = await writeIso(join(dir, "bad.iso"), [{ path: "a", file: join(dir, "nope") }], { volumeId: "V" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IsoError);
      expect((error as Error).message).toMatch(/cannot read/);
    });

    it("a host directory given as a file", async () => {
      const error = await writeIso(join(dir, "bad.iso"), [{ path: "a", file: dir }], { volumeId: "V" }).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/not a regular file/);
    });

    it("a timestamp ISO 9660 cannot record", async () => {
      const error = await writeIso(join(dir, "bad.iso"), [], { volumeId: "V", timestamp: new Date("1800-01-01T00:00:00Z") }).catch(
        (e: unknown) => e,
      );
      expect((error as Error).message).toMatch(/1900\.\.2155/);
    });
  });
});

describe("entriesFromDirectory", () => {
  it("mirrors a host tree, empty directories included", async () => {
    const source = join(dir, "src");
    await mkdir(join(source, "units", "nested"), { recursive: true });
    await mkdir(join(source, "empty"), { recursive: true });
    await writeFile(join(source, "units", "a.service"), "A");
    await writeFile(join(source, "units", "nested", "b.conf"), "B");
    await writeFile(join(source, "top.txt"), "T");

    const entries = await entriesFromDirectory(source, "opt");
    expect(entries).toEqual([
      { path: "opt/empty", directory: true },
      { path: "opt/top.txt", file: join(source, "top.txt") },
      { path: "opt/units/a.service", file: join(source, "units", "a.service") },
      { path: "opt/units/nested/b.conf", file: join(source, "units", "nested", "b.conf") },
    ]);

    const { image, iso } = await build(await entriesFromDirectory(source), "IDOTS-RT", "tree.iso");
    const files = listFiles(iso.joliet.root);
    expect(fileBytes(image, files.get("units/nested/b.conf")!).toString()).toBe("B");
    expect(listDirectories(iso.joliet.root)).toEqual(["empty", "units", "units/nested"]);
  });
});
