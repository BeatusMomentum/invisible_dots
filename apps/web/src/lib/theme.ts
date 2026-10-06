/**
 * Light, dark or follow the system. The person's choice lives in localStorage (a per-viewer convenience: the page
 * works without it) and the choice in force is the `data-theme` attribute of <html>, which tokens.css reads. One
 * function, `applyTheme`, turns the first into the second. It also runs inline in the document head before the
 * first paint (`THEME_BOOTSTRAP`), so a dark page never flashes light; that is why it uses nothing but its
 * argument and browser globals. The React hooks that follow the theme are in use-theme.ts, so that a server
 * component (the root layout, for the script) can import this file.
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "idots-theme";
export const THEME_CHANGED = "idots-theme-changed";

/** Set `data-theme` from the stored preference, and from the system when the preference is "system" or unreadable. */
export function applyTheme(key: string): void {
  let preference: string | null = null;
  try {
    preference = localStorage.getItem(key);
  } catch {
    // Storage blocked: follow the system.
  }
  const dark = preference === "dark" || (preference !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/** The inline script for the document head. */
export const THEME_BOOTSTRAP = `(${applyTheme.toString()})(${JSON.stringify(THEME_KEY)})`;

export function storedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
