/** The design tokens as the tests read them: the custom properties of src/app/tokens.css, per theme. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");

const tokensCss = readFileSync(join(SRC, "app/tokens.css"), "utf8");

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

export type Theme = "light" | "dark";
export const themes: Record<Theme, Record<string, string>> = { light: colorsOf(block(":root")), dark: colorsOf(block(':root[data-theme="dark"]')) };
