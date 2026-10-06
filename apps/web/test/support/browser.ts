import { vi } from "vitest";

/** jsdom has no `matchMedia`; this one says the system is in light mode and never changes. */
export function stubMatchMedia(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
}
