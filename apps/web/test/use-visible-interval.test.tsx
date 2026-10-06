// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisibleInterval } from "../src/lib/use-visible-interval";

let hidden = false;

function Probe({ tick, ms = 1000, enabled = true }: { tick: () => void | Promise<void>; ms?: number; enabled?: boolean }) {
  useVisibleInterval(tick, ms, enabled);
  return null;
}

function setHidden(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useVisibleInterval", () => {
  it("polls at once and then once per period", async () => {
    const tick = vi.fn();
    render(<Probe tick={tick} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(tick).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it("asks nothing while the page is hidden, and polls at once when it is shown again", async () => {
    const tick = vi.fn();
    render(<Probe tick={tick} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    setHidden(true);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(tick).toHaveBeenCalledTimes(1);
    await act(async () => setHidden(false));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("never runs two at a time: the next is scheduled when the last has finished", async () => {
    let running = 0;
    let overlap = 0;
    const tick = vi.fn(async () => {
      running++;
      overlap = Math.max(overlap, running);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      running--;
    });
    render(<Probe tick={tick} />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(overlap).toBe(1);
    // Each takes 2.5 s and the period starts after it: 0, 3.5, 7.0 s.
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("keeps time when a poll throws", async () => {
    const tick = vi.fn(async () => {
      throw new Error("no answer");
    });
    render(<Probe tick={tick} />);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("stops when disabled and when unmounted, and calls the latest function it was given", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Probe tick={first} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.rerender(<Probe tick={second} />);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    view.rerender(<Probe tick={second} enabled={false} />);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(second).toHaveBeenCalledTimes(1);

    view.rerender(<Probe tick={second} enabled />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(second).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(second).toHaveBeenCalledTimes(2);
  });
});
