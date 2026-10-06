import { describe, expect, it } from "vitest";
import { relativeTime } from "../src/lib/time";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("relativeTime", () => {
  it("says how long ago, in the unit that reads best", () => {
    expect(relativeTime(at(-20_000), NOW)).toBe("Just now");
    expect(relativeTime(at(-5 * MIN), NOW)).toBe("5m ago");
    expect(relativeTime(at(-59 * MIN), NOW)).toBe("59m ago");
    expect(relativeTime(at(-3 * HOUR), NOW)).toBe("3h ago");
  });

  it("gives the date once it is a day old or more", () => {
    const old = at(-3 * 24 * HOUR);
    expect(relativeTime(old, NOW)).toBe(new Date(old).toLocaleDateString());
  });

  it("says how long until a time that has not come", () => {
    expect(relativeTime(at(10_000), NOW)).toBe("Just now");
    expect(relativeTime(at(5 * MIN), NOW)).toBe("in 5m");
    expect(relativeTime(at(3 * HOUR + 10), NOW)).toBe("in 3h");
    expect(relativeTime(at(2 * 24 * HOUR + HOUR), NOW)).toBe("in 2d");
  });

  it("takes a Date or a number as well, and gives back what is not a time", () => {
    expect(relativeTime(new Date(NOW - 2 * MIN), NOW)).toBe("2m ago");
    expect(relativeTime(NOW - 2 * HOUR, NOW)).toBe("2h ago");
    expect(relativeTime("yesterday-ish", NOW)).toBe("yesterday-ish");
  });
});
