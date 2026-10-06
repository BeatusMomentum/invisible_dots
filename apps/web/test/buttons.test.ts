/**
 * The buttons as the person sees them. The variants of components/ui/button.tsx are read from the source and each
 * state of each is resolved to the text and the fill its classes give it (a fill with `/n` is that percent of the token
 * over the surface the button sits on), so a variant that sets no text color gets the page's, as the browser gives it.
 * The measure is WCAG AA, 4.5 to 1, in both themes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, fromHex, over, type Rgb } from "./support/contrast";
import { SRC, themes, type Theme } from "./support/tokens";

const source = readFileSync(join(SRC, "components/ui/button.tsx"), "utf8");
const variantBlock = source.slice(source.indexOf("variant: {"), source.indexOf("size: {"));
const VARIANTS = Object.fromEntries([...variantBlock.matchAll(/^\s+(\w+):\s*"([^"]+)"/gm)].map((m) => [m[1]!, m[2]!.split(/\s+/)]));

/** The surfaces a button sits on: the page, a card, a popover. */
const SURFACES = ["background", "card", "popover"];

function colorsOf(variant: string, theme: Theme, hover: boolean, surface: string): { text: Rgb; fill: Rgb } {
  const tokens = themes[theme];
  const color = (name: string): Rgb => {
    if (!(name in tokens)) throw new Error(`${variant}: ${name} is not a token`);
    return fromHex(tokens[name]!);
  };
  let text = color("foreground");
  let fill = color(surface);
  for (const word of VARIANTS[variant]!) {
    const prefixes = word.split(":");
    const utility = prefixes.pop()!;
    if (prefixes.some((prefix) => prefix !== "dark" && prefix !== "hover")) continue;
    if (prefixes.includes("dark") && theme !== "dark") continue;
    if (prefixes.includes("hover") && !hover) continue;
    const fillClass = /^bg-([\w-]+?)(?:\/(\d+))?$/.exec(utility);
    if (fillClass) fill = over(color(fillClass[1]!), Number(fillClass[2] ?? 100) / 100, color(surface));
    const textClass = /^text-([\w-]+)$/.exec(utility);
    if (textClass && textClass[1]! in tokens) text = color(textClass[1]!);
  }
  return { text, fill };
}

describe("the buttons", () => {
  it("are read from the source: every variant is found", () => {
    expect(Object.keys(VARIANTS).sort()).toEqual(["default", "destructive", "ghost", "link", "outline", "secondary"]);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const variant of Object.keys(VARIANTS).filter((name) => name !== "link")) {
      for (const hover of [false, true]) {
        for (const surface of SURFACES) {
          it(`${variant} reads at AA on the ${surface}${hover ? " when hovered" : ""} (${theme})`, () => {
            const { text, fill } = colorsOf(variant, theme, hover, surface);
            expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
    }
  }

  it("take the dark outline button for what it is: the page's text on the input color at a fraction", () => {
    // The case the review could not prove. No text utility: the text is the page's, on a translucent fill.
    const { text, fill } = colorsOf("outline", "dark", false, "background");
    expect(text).toEqual(fromHex(themes.dark.foreground!));
    expect(fill).not.toEqual(fromHex(themes.dark.background!));
    expect(contrast(text, fill)).toBeGreaterThan(10);
  });

  it("would catch an outline button that took the primary-foreground text, as the old stylesheet gave it", () => {
    const wrong = fromHex(themes.dark["primary-foreground"]!);
    const { fill } = colorsOf("outline", "dark", false, "background");
    expect(contrast(wrong, fill)).toBeLessThan(4.5);
  });
});
