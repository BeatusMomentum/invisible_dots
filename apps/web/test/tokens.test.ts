import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAVICON_ATTENTION, FAVICON_PRIMARY } from "../src/lib/favicon";
import { contrast as contrastOf, fromHex, over } from "./support/contrast";
import { SRC, themes } from "./support/tokens";

const globalsCss = readFileSync(join(SRC, "app/globals.css"), "utf8");

/** WCAG 2.x contrast ratio of two #rrggbb colors. */
const contrast = (a: string, b: string) => contrastOf(fromHex(a), fromHex(b));

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
  ["primary-foreground", "primary-hover"],
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

  it("keeps the shimmering label visible under forced colors, where the gradient behind the transparent text fill is dropped", () => {
    const shimmer = /@utility shimmer \{([\s\S]*?)\n\}/.exec(globalsCss)?.[1] ?? "";
    expect(shimmer).toContain("-webkit-text-fill-color: transparent");
    const forced = /@media \(forced-colors: active\) \{([^}]*)\}/.exec(shimmer)?.[1] ?? "";
    expect(forced).toContain("-webkit-text-fill-color: currentColor");
    expect(forced).toContain("background-image: none");
  });

  it("keeps the favicon's two colors equal to the tokens they copy", () => {
    expect(FAVICON_PRIMARY).toBe(themes.light.primary);
    expect(FAVICON_ATTENTION).toBe(themes.light.attention);
  });
});

/** Every .tsx file of the components, as text. */
function sources(): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx")) found.push({ file: path.slice(SRC.length + 1), text: readFileSync(path, "utf8") });
    }
  };
  walk(join(SRC, "components"));
  return found;
}

describe("the focus indicator", () => {
  const all = sources();

  it("is a ring whose opacity still reads at 3:1 against every surface it can sit on, in both themes (the solid token passing is not enough: the ring is drawn at its opacity)", () => {
    const opacities = new Set(all.flatMap(({ text }) => [...text.matchAll(/(?:focus-visible|focus-within|focus|has-\[:focus-visible\]):ring-ring\/(\d+)/g)].map((m) => Number(m[1]))));
    expect(opacities.size).toBeGreaterThan(0);
    for (const [name, tokens] of Object.entries(themes)) {
      for (const surface of ["background", "card", "popover"]) {
        for (const opacity of opacities) {
          const drawn = over(fromHex(tokens.ring!), opacity / 100, fromHex(tokens[surface]!));
          expect(contrastOf(drawn, fromHex(tokens[surface]!)), `ring-ring/${opacity} on ${surface}, ${name}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("is also an outline that forced colors keep: no control drops its outline for good, and every file that draws a focus ring says `outline-hidden` for the same trigger", () => {
    for (const { file, text } of all) {
      expect(text, file).not.toMatch(/(?<![\w:-])outline-none(?![\w-])/);
      for (const trigger of ["focus-visible", "focus-within", "has-[:focus-visible]"]) {
        if (text.includes(`${trigger}:ring-[3px]`) || text.includes(`${trigger}:ring-ring`)) expect(text, `${file} draws a ${trigger} ring`).toContain(`${trigger}:outline-hidden`);
      }
    }
  });

  it("marks the selected card of the Inbox with an outline, which forced colors keep, and not with a ring (a shadow they remove)", () => {
    const card = all.find(({ file }) => file.endsWith("ApprovalCard.tsx"))!.text;
    expect(card).toContain('selected && "outline-2 outline-offset-2 outline-ring"');
    expect(card).not.toMatch(/selected && "ring-/);
  });
});
