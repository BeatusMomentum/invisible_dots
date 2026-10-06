import { describe, expect, it } from "vitest";
import { COMPUTER_VIEWS, computerHref, parseComputerQuery } from "../src/lib/computer-view";

describe("the address of the Computer page", () => {
  it("opens on the screen when it says nothing, or something that is not a view", () => {
    expect(parseComputerQuery({})).toEqual({ view: "screen", path: null, file: null });
    expect(parseComputerQuery({ view: "terminal" })).toEqual({ view: "screen", path: null, file: null });
    expect(parseComputerQuery({ view: "" })).toEqual({ view: "screen", path: null, file: null });
  });

  it("reads each view, and the first of a value given twice", () => {
    for (const view of COMPUTER_VIEWS) expect(parseComputerQuery({ view }).view).toBe(view);
    expect(parseComputerQuery({ view: ["usage", "files"] }).view).toBe("usage");
  });

  it("keeps the folder and the file for the Files view alone", () => {
    expect(parseComputerQuery({ view: "files", path: "/home/dot/memory", file: "fares.md" })).toEqual({ view: "files", path: "/home/dot/memory", file: "fares.md" });
    expect(parseComputerQuery({ view: "browser", path: "/home/dot/memory", file: "fares.md" })).toEqual({ view: "browser", path: null, file: null });
  });

  it("writes the shortest address that says the same, with the Dot's name or id encoded", () => {
    expect(computerHref("d1")).toBe("/dots/d1/computer");
    expect(computerHref("d1", { view: "screen" })).toBe("/dots/d1/computer");
    expect(computerHref("d1", { view: "browser" })).toBe("/dots/d1/computer?view=browser");
    expect(computerHref("my dot", { view: "usage" })).toBe("/dots/my%20dot/computer?view=usage");
    expect(computerHref("d1", { view: "files" })).toBe("/dots/d1/computer?view=files");
    expect(computerHref("d1", { view: "files", path: "/home/dot/a b", file: "c&d.txt" })).toBe("/dots/d1/computer?view=files&path=%2Fhome%2Fdot%2Fa+b&file=c%26d.txt");
    // A folder named for another view is not carried into it.
    expect(computerHref("d1", { view: "usage", path: "/home/dot", file: "x" })).toBe("/dots/d1/computer?view=usage");
  });

  it("reads back what it wrote", () => {
    const query = { view: "files", path: "/home/dot/a b", file: "c&d.txt" } as const;
    const search = new URL(computerHref("d1", query), "http://x").searchParams;
    expect(parseComputerQuery(Object.fromEntries(search))).toEqual(query);
  });
});
