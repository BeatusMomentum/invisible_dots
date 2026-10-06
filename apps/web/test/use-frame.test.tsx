// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFrame } from "../src/components/computer/use-frame";
import { stubObjectUrls } from "./support/browser";

beforeEach(() => {
  stubObjectUrls();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bytes = (...values: number[]) => Uint8Array.from(values) as Uint8Array<ArrayBuffer>;

describe("useFrame", () => {
  it("asks for one frame at a time: a refresh during a read in flight starts no second one", async () => {
    const answers: ((value: Uint8Array<ArrayBuffer>) => void)[] = [];
    const load = vi.fn(() => new Promise<Uint8Array<ArrayBuffer>>((resolve) => answers.push(resolve)));
    const { result } = renderHook(() => useFrame(load, "image/jpeg", 1000, false));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.refresh();
      second = result.current.refresh();
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);

    await act(async () => {
      answers[0]!(bytes(1));
      await Promise.all([first, second]);
    });
    expect(result.current.url).not.toBeNull();
    expect(result.current.pending).toBe(false);

    // The read has ended: the next refresh reads again.
    act(() => {
      void result.current.refresh();
    });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => answers[1]!(bytes(2)));
  });

  it("lets a refresh through again after a failed read", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(bytes(1));
    const { result } = renderHook(() => useFrame(load, "image/jpeg", 1000, false));
    await act(() => result.current.refresh());
    expect(result.current.error).toBeInstanceOf(Error);
    await act(() => result.current.refresh());
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.url).not.toBeNull();
  });
});
