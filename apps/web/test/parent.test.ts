import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitWhenParentGone, parentPidFrom } from "../src/lib/parent.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("exitWhenParentGone", () => {
  it("does nothing while the parent exists, and calls onGone once when it is gone", () => {
    let alive = true;
    const asked: number[] = [];
    const onGone = vi.fn();
    exitWhenParentGone(4242, {
      exists: (pid) => {
        asked.push(pid);
        return alive;
      },
      onGone,
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(3000);
    expect(onGone).not.toHaveBeenCalled();
    expect(asked).toEqual([4242, 4242, 4242]);

    alive = false;
    vi.advanceTimersByTime(5000);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(4);
  });

  it("stops looking when told to", () => {
    const onGone = vi.fn();
    const stop = exitWhenParentGone(4242, { exists: () => false, onGone, intervalMs: 1000 });
    stop();
    vi.advanceTimersByTime(5000);
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe("parentPidFrom", () => {
  it("reads a positive integer and nothing else", () => {
    expect(parentPidFrom("4242")).toBe(4242);
    for (const bad of [undefined, "", "0", "-1", "1.5", "12abc", " 7", "1e3", "99999999999999999999"]) {
      expect(parentPidFrom(bad)).toBeUndefined();
    }
  });
});
