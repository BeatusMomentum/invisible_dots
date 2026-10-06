import { vi } from "vitest";

/**
 * jsdom has no `matchMedia`; this one answers every query the same: "no" by default (light mode, a narrow window), or
 * "yes" when `matches` is true (a wide window; dark mode too, which no test of a wide window looks at). It never changes.
 */
export function stubMatchMedia(matches = false): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches, addEventListener() {}, removeEventListener() {} })),
  );
}

/** jsdom has no layout, so no `ResizeObserver`: this one never reports a size, which leaves a scrolling thread where it is. */
export function stubResizeObserver(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

/**
 * jsdom has no object URLs: each one made here is a distinct address that the test can see being made and revoked.
 * It is set on `URL` itself, which lasts for the test file (every file has its own jsdom).
 */
export function stubObjectUrls(): { created: string[]; revoked: string[] } {
  const record = { created: [] as string[], revoked: [] as string[] };
  let next = 0;
  URL.createObjectURL = () => {
    const url = `blob:test/${++next}`;
    record.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    record.revoked.push(url);
  };
  return record;
}
