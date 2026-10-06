// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "../src/components/shell/ThemeToggle";
import { applyTheme, storedPreference, THEME_BOOTSTRAP, THEME_KEY } from "../src/lib/theme";
import { useResolvedTheme } from "../src/lib/use-theme";
import { stubResizeObserver } from "./support/browser";

let systemDark: boolean;
let mediaListeners: Set<() => void>;

beforeEach(() => {
  systemDark = false;
  mediaListeners = new Set();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  // The toggle's tooltip is positioned, which jsdom cannot measure.
  stubResizeObserver();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const theme = () => document.documentElement.dataset.theme;

describe("applying the theme", () => {
  it("follows the system when nothing is stored, and obeys what is stored", () => {
    applyTheme(THEME_KEY);
    expect(theme()).toBe("light");
    systemDark = true;
    applyTheme(THEME_KEY);
    expect(theme()).toBe("dark");
    localStorage.setItem(THEME_KEY, "light");
    applyTheme(THEME_KEY);
    expect(theme()).toBe("light");
    systemDark = false;
    localStorage.setItem(THEME_KEY, "dark");
    applyTheme(THEME_KEY);
    expect(theme()).toBe("dark");
  });

  it("follows the system, and does not throw, when the storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    systemDark = true;
    expect(() => applyTheme(THEME_KEY)).not.toThrow();
    expect(theme()).toBe("dark");
    expect(storedPreference()).toBe("system");
    vi.restoreAllMocks();
  });

  it("ignores a stored value that is neither light nor dark", () => {
    localStorage.setItem(THEME_KEY, "purple");
    expect(storedPreference()).toBe("system");
  });

  it("runs on its own as the inline script of the document head, before any module is loaded", () => {
    systemDark = true;
    // The script is a string with the function written out in it: nothing it uses may come from this module.
    new Function(THEME_BOOTSTRAP)();
    expect(theme()).toBe("dark");
    localStorage.setItem(THEME_KEY, "light");
    new Function(THEME_BOOTSTRAP)();
    expect(theme()).toBe("light");
  });
});

describe("the theme toggle", () => {
  function Probe() {
    return <p data-testid="resolved">{useResolvedTheme()}</p>;
  }

  it("stores the choice, applies it at once and says which one is in force", async () => {
    applyTheme(THEME_KEY);
    render(
      <>
        <ThemeToggle />
        <Probe />
      </>,
    );
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Theme: System" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(theme()).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Theme: Dark" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "System" }));
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(theme()).toBe("light");
  });

  it("follows the system's change while the choice is System, and not otherwise", async () => {
    applyTheme(THEME_KEY);
    render(
      <>
        <ThemeToggle />
        <Probe />
      </>,
    );
    systemDark = true;
    act(() => mediaListeners.forEach((listener) => listener()));
    await waitFor(() => expect(screen.getByTestId("resolved").textContent).toBe("dark"));

    // With a choice stored the system's change is not followed.
    localStorage.setItem(THEME_KEY, "light");
    applyTheme(THEME_KEY);
    await waitFor(() => expect(screen.getByTestId("resolved").textContent).toBe("light"));
    act(() => mediaListeners.forEach((listener) => listener()));
    expect(theme()).toBe("light");
  });

  it("still switches this page, though it cannot remember the choice, when the storage is blocked", async () => {
    render(<ThemeToggle />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError");
    });
    await userEvent.click(screen.getByRole("button", { name: /^Theme:/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    expect(theme()).toBe("dark");
    vi.restoreAllMocks();
  });
});
