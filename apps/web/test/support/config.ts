import { parseDotConfig, type DotConfig } from "@invisible-dots/shared/browser";

/** A whole Dot config as the API stores it: every default applied, the way a real record's config always is. */
export function fullConfig(change: Record<string, unknown> = {}): DotConfig {
  return parseDotConfig({
    name: "fare-watch",
    goal: "Watch the fares from Milan to Lisbon",
    model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
    ...change,
  });
}
