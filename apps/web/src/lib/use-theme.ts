"use client";

/** The hooks that follow the theme in force and the person's choice (the rules are in theme.ts). */
import { useCallback, useSyncExternalStore } from "react";
import { applyTheme, storedPreference, THEME_CHANGED, THEME_KEY, type ResolvedTheme, type ThemePreference } from "./theme";

function subscribe(onChange: () => void): () => void {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onSystem = () => {
    // Only a "system" preference follows the system.
    if (storedPreference() === "system") applyTheme(THEME_KEY);
  };
  media.addEventListener("change", onSystem);
  window.addEventListener(THEME_CHANGED, onChange);
  window.addEventListener("storage", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    media.removeEventListener("change", onSystem);
    window.removeEventListener(THEME_CHANGED, onChange);
    window.removeEventListener("storage", onChange);
    observer.disconnect();
  };
}

/** The theme in force, `light` on the server. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    () => "light",
  );
}

/** The person's choice and a way to change it. */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(subscribe, storedPreference, () => "system" as ThemePreference);
  const set = useCallback((next: ThemePreference) => {
    let stored = true;
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      stored = false;
    }
    // Without storage the choice cannot be read back, so it is set directly and holds for this page only.
    if (stored || next === "system") applyTheme(THEME_KEY);
    else document.documentElement.dataset.theme = next;
    window.dispatchEvent(new Event(THEME_CHANGED));
  }, []);
  return [preference, set];
}
