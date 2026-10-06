import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAVICON_ATTENTION, FAVICON_PRIMARY } from "../src/lib/favicon";

const APP = join(dirname(fileURLToPath(import.meta.url)), "../src/app");
const tokensCss = readFileSync(join(APP, "tokens.css"), "utf8");
const globalsCss = readFileSync(join(APP, "globals.css"), "utf8");

/** The custom properties declared in one block of tokens.css. */
function block(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  const body = tokensCss.slice(start, tokensCss.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** Not colors, so not themed: they are declared once, in the light block. */
const SHARED = ["radius", "font-ui", "font-code"];
const colorsOf = (tokens: Record<string, string>) => Object.fromEntries(Object.entries(tokens).filter(([key]) => !SHARED.includes(key)));
const themes = { light: colorsOf(block(":root")), dark: colorsOf(block(':root[data-theme="dark"]')) };

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.x contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Text on its surface: WCAG AA for normal text. */
const TEXT_PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["primary-foreground", "primary"],
  ["destructive-foreground", "destructive"],
  // Status text on its soft surface, and on the plain surfaces it also appears on.
  ["ok", "ok-soft"],
  ["warn", "warn-soft"],
  ["danger", "danger-soft"],
  ["info", "info-soft"],
  ["ok", "card"],
  ["warn", "card"],
  ["danger", "card"],
  ["danger", "popover"],
  ["info", "card"],
  ["warn", "background"],
  ["danger", "background"],
  // The accent as the color of a link or a label on the page.
  ["primary", "background"],
  ["primary", "card"],
];

/** Things that are drawn, not read (rings, focus outline, badges): WCAG 1.4.11, three to one. */
const GRAPHIC_PAIRS: [string, string][] = [
  ["ring", "background"],
  ["ring", "card"],
  ["primary", "card"],
  ["ok", "card"],
  ["danger", "card"],
  ["attention", "card"],
  ["attention", "background"],
];

describe("the contrast measure", () => {
  it("is the WCAG ratio: 21 for black on white, 1 for a color on itself, and below AA for a pale grey on white", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#5b5bd6", "#5b5bd6")).toBe(1);
    expect(contrast("#aaaaaa", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("the design tokens", () => {
  for (const [name, tokens] of Object.entries(themes)) {
    describe(`${name} theme`, () => {
      it("defines every token the other theme defines", () => {
        expect(Object.keys(tokens).sort()).toEqual(Object.keys(name === "light" ? themes.dark : themes.light).sort());
      });

      it.each(TEXT_PAIRS)("%s on %s reads at AA (4.5:1)", (foreground, background) => {
        expect(contrast(tokens[foreground]!, tokens[background]!)).toBeGreaterThanOrEqual(4.5);
      });

      it.each(GRAPHIC_PAIRS)("%s against %s is seen at 3:1", (color, surface) => {
        expect(contrast(tokens[color]!, tokens[surface]!)).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it("maps every color token into Tailwind, and only those", () => {
    const mapped = [...globalsCss.matchAll(/--color-([\w-]+): var\(--([\w-]+)\);/g)].map((m) => [m[1], m[2]]);
    for (const [utility, token] of mapped) expect(utility).toBe(token);
    expect(mapped.map(([utility]) => utility).sort()).toEqual(Object.keys(themes.light).sort());
  });

  it("keeps the favicon's two colors equal to the tokens they copy", () => {
    expect(FAVICON_PRIMARY).toBe(themes.light.primary);
    expect(FAVICON_ATTENTION).toBe(themes.light.attention);
  });
});
