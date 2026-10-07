import { describe, expect, it } from "vitest";
import { idTimestamp, newId } from "../src/index.js";

describe("newId", () => {
  it("has the prefix, a fixed length and a lowercase alphabet", () => {
    const id = newId("dot");
    expect(id).toMatch(/^dot_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it("sorts by creation time", () => {
    const ids = [3, 1_700_000_000_000, 2, 1_700_000_000_001, 1_000].map((ms) => newId("task", ms));
    const sorted = [...ids].sort();
    expect(sorted.map((id) => idTimestamp(id))).toEqual([2, 3, 1_000, 1_700_000_000_000, 1_700_000_000_001]);
  });

  it("round-trips the timestamp", () => {
    const now = Date.UTC(2026, 9, 2, 8, 0, 0, 123);
    expect(idTimestamp(newId("evt", now))).toBe(now);
    expect(idTimestamp("not-an-id")).toBeNull();
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("x", 42)));
    expect(ids.size).toBe(2000);
  });

  it("refuses prefixes that would break paths or VM names", () => {
    expect(() => newId("")).toThrow(/invalid id prefix/);
    expect(() => newId("Dot")).toThrow(/invalid id prefix/);
    expect(() => newId("a/b")).toThrow(/invalid id prefix/);
  });
});
