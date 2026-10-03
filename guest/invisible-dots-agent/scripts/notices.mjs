// The license notices of everything the agent bundle carries (architecture
// section 11.3), generated from esbuild's metafile at build time, so the list
// can never drift from what is actually bundled: this repository's own code,
// the files derived from Open Multi-Agent, and every npm package an input
// comes from, each with the license and notice files of its package.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[a-z0-9]+)?$/i;

function licenseTexts(dir) {
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n").trim());
}

/** The root directory of the npm package an input path belongs to, or undefined. */
function packageRoot(file) {
  const parts = file.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const scoped = parts[at + 1].startsWith("@");
  return parts.slice(0, at + (scoped ? 3 : 2)).join(sep);
}

/**
 * @param {{ metafile: { inputs: Record<string, unknown> }, workingDir: string, repoRoot: string }} options
 * @returns {string} the text of THIRD_PARTY_NOTICES.txt
 */
export function thirdPartyNotices({ metafile, workingDir, repoRoot }) {
  const engineSrc = resolve(repoRoot, "guest-runtime", "engine", "src") + sep;
  const packages = new Map();
  let engine = false;
  for (const input of Object.keys(metafile.inputs)) {
    const file = resolve(workingDir, input);
    if (file.startsWith(engineSrc) && !file.startsWith(join(engineSrc, "dot") + sep)) engine = true;
    const root = packageRoot(file);
    if (root === undefined || packages.has(root)) continue;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    packages.set(root, { name: manifest.name ?? root, version: manifest.version ?? "", license: manifest.license ?? "unknown", texts: licenseTexts(root) });
  }

  const sections = [
    "invisible-dots-agent.mjs bundles the code below. Each part is under its own license; the full texts follow.",
    "",
    `== invisible_dots (MIT)\n\n${readFileSync(join(repoRoot, "LICENSE"), "utf8").replace(/\r\n/g, "\n").trim()}`,
  ];
  if (engine) {
    const text = readFileSync(join(repoRoot, "guest-runtime", "engine", "LICENSE"), "utf8").replace(/\r\n/g, "\n").trim();
    sections.push(`== Open Multi-Agent (MIT), parts of the agent engine (guest-runtime/engine/UPSTREAM.md)\n\n${text}`);
  }
  const sorted = [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  for (const pkg of sorted) {
    const body = pkg.texts.length > 0 ? pkg.texts.join("\n\n") : `(the package ships no license file; its package.json declares "${pkg.license}")`;
    sections.push(`== ${pkg.name} ${pkg.version} (${pkg.license})\n\n${body}`);
  }
  return `${sections.join("\n\n")}\n`;
}

/** Where the notices go: next to the bundle. */
export function noticesPath(bundle) {
  return join(dirname(bundle), "THIRD_PARTY_NOTICES.txt");
}
