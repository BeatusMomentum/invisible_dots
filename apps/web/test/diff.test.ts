import { describe, expect, it } from "vitest";
import { additionDiff, diffStats, linesOf, replacementDiff, type DiffLine } from "../src/lib/diff";
import { clamp, take } from "../src/lib/range";

const kinds = (lines: DiffLine[]) => lines.map((line) => `${line.kind}:${line.text}`);

describe("the lines of a text", () => {
  it("are none for an empty text, and a final line break does not add an empty line", () => {
    expect(linesOf("")).toEqual([]);
    expect(linesOf("a")).toEqual(["a"]);
    expect(linesOf("a\nb\n")).toEqual(["a", "b"]);
    expect(linesOf("a\r\nb")).toEqual(["a", "b"]);
    // An empty line in the middle, or two at the end, are lines.
    expect(linesOf("a\n\nb")).toEqual(["a", "", "b"]);
    expect(linesOf("a\n\n")).toEqual(["a", ""]);
  });
});

describe("a preview of a change", () => {
  it("shows every line of a whole file as added", () => {
    expect(kinds(additionDiff("one\ntwo\n"))).toEqual(["add:one", "add:two"]);
    expect(additionDiff("")).toEqual([]);
  });

  it("removes what the old text had and adds what the new one has, keeping a little of what they share", () => {
    const before = ["a", "b", "c", "d", "OLD", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "NEW", "e", "f", "g", "h"].join("\n");
    // Two lines of context on each side, not the whole text.
    expect(kinds(replacementDiff(before, after))).toEqual(["context:c", "context:d", "remove:OLD", "add:NEW", "context:e", "context:f"]);
  });

  it("handles a change at either end, a pure insertion and a pure deletion", () => {
    expect(kinds(replacementDiff("x\ny", "x\ny\nz"))).toEqual(["context:x", "context:y", "add:z"]);
    expect(kinds(replacementDiff("x\ny\nz", "y\nz"))).toEqual(["remove:x", "context:y", "context:z"]);
    expect(kinds(replacementDiff("", "new"))).toEqual(["add:new"]);
    expect(kinds(replacementDiff("gone", ""))).toEqual(["remove:gone"]);
    expect(replacementDiff("same", "same")).toEqual([{ kind: "context", text: "same" }]);
  });

  it("decides a line's kind by how the preview is built, not by what the line starts with", () => {
    // A removed line of dashes is a removed line, not a heading; an added line of plus signs is an added one.
    expect(kinds(replacementDiff("--- a rule ---", "+++ a rule +++"))).toEqual(["remove:--- a rule ---", "add:+++ a rule +++"]);
    expect(kinds(additionDiff("@@ not a hunk @@\ndiff --git"))).toEqual(["add:@@ not a hunk @@", "add:diff --git"]);
  });

  it("counts the lines added and removed", () => {
    expect(diffStats(replacementDiff("a\nb\nc", "a\nB\nC\nD"))).toEqual({ added: 3, removed: 2 });
    expect(diffStats([])).toEqual({ added: 0, removed: 0 });
  });
});

describe("range", () => {
  it("clamps into bounds, sends NaN to the minimum and lets the maximum win when the bounds are inverted", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(Number.NaN, 2, 3)).toBe(2);
    expect(clamp(3, 1, 0)).toBe(0);
  });

  it("takes the first items for a count that may be out of range", () => {
    expect(take([1, 2, 3], 2)).toEqual([1, 2]);
    expect(take([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(take([1, 2, 3], -4)).toEqual([]);
    expect(take([1, 2, 3], Number.NaN)).toEqual([]);
    expect(take([1, 2, 3], 1.9)).toEqual([1]);
  });
});
