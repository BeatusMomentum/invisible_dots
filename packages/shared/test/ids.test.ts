import { describe, expect, it } from "vitest";
import { idTimestamp, isValidIdentityId, newId, newIdentityId, slugify } from "../src/index.js";

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

  it("refuses prefixes that would break paths or domain names", () => {
    expect(() => newId("")).toThrow(/invalid id prefix/);
    expect(() => newId("Dot")).toThrow(/invalid id prefix/);
    expect(() => newId("a/b")).toThrow(/invalid id prefix/);
  });
});

describe("slugify", () => {
  it("makes lowercase dash-separated slugs", () => {
    expect(slugify("Shopping Account #2")).toBe("shopping-account-2");
    expect(slugify("  Cafe\u0301 Ole\u0301  ")).toBe("cafe-ole");
    expect(slugify("Z\u00fcrich M\u00fcller")).toBe("zurich-muller");
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
  });

  it("is never empty and never too long", () => {
    expect(slugify("!!!")).toBe("identity");
    expect(slugify("", "dot")).toBe("dot");
    const long = slugify("a ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("newIdentityId", () => {
  it("is the slug plus a short random suffix, and valid", () => {
    const id = newIdentityId("Work Profile");
    expect(id).toMatch(/^work-profile-[0-9a-hjkmnp-tv-z]{6}$/);
    expect(isValidIdentityId(id)).toBe(true);
    expect(newIdentityId("Work Profile")).not.toBe(id);
  });

  it("rejects ids that could escape the browsers directory", () => {
    expect(isValidIdentityId("..")).toBe(false);
    expect(isValidIdentityId("a/b")).toBe(false);
    expect(isValidIdentityId("A")).toBe(false);
    expect(isValidIdentityId("")).toBe(false);
    expect(isValidIdentityId("-a")).toBe(false);
  });
});
