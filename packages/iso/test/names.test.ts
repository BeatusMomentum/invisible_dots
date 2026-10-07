import { describe, expect, it } from "vitest";
import { comparePrimaryIds, PrimaryNamer, splitImagePath } from "../src/names.js";

describe("PrimaryNamer", () => {
  it("derives level 1 names", () => {
    const namer = new PrimaryNamer();
    expect(namer.file("user-data")).toBe("USER_DAT.;1");
    expect(namer.file("config.json")).toBe("CONFIG.JSO;1");
    expect(namer.file(".bashrc")).toBe("_BASHRC.;1");
    const eAcute = String.fromCharCode(0xe9);
    expect(namer.file(`r${eAcute}sum${eAcute}.md`)).toBe("R_SUM_.MD;1");
    expect(namer.directory("invisible-dots")).toBe("INVISIBL");
    expect(namer.directory("...")).toBe("___");
  });

  it("keeps names unique within one directory", () => {
    const namer = new PrimaryNamer();
    expect(namer.file("invisible-dots-agent.service")).toBe("INVISIBL.SER;1");
    expect(namer.file("invisible-dots-agentd.service")).toBe("INVISIB1.SER;1");
    expect(namer.file("invisible-dots-other.service")).toBe("INVISIB2.SER;1");
    expect(namer.directory("invisible-dots")).toBe("INVISIBL");
    expect(namer.directory("invisible-dots-2")).toBe("INVISIB1");
    // A different extension is a different identifier.
    expect(namer.file("invisible-dots.conf")).toBe("INVISIBL.CON;1");
    // Ten collisions need a two-digit suffix.
    const many = new PrimaryNamer();
    const names = Array.from({ length: 12 }, (_, i) => many.file(`same-prefix-${i}.txt`));
    expect(new Set(names).size).toBe(12);
    expect(names[10]).toBe("SAME_P10.TXT;1");
  });

  it("is reset per directory", () => {
    expect(new PrimaryNamer().file("a")).toBe(new PrimaryNamer().file("a"));
  });
});

describe("comparePrimaryIds", () => {
  it("orders by name, then extension, as if padded with spaces", () => {
    const ids = ["B.;1", "A.TXT;1", "AB.;1", "A.;1", "A_.;1", "A1.;1"];
    expect([...ids].sort(comparePrimaryIds)).toEqual(["A.;1", "A.TXT;1", "A1.;1", "AB.;1", "A_.;1", "B.;1"]);
  });
});

describe("splitImagePath", () => {
  it("accepts a leading slash and nested names", () => {
    expect(splitImagePath("/a/b c/d.txt")).toEqual(["a", "b c", "d.txt"]);
  });
});
