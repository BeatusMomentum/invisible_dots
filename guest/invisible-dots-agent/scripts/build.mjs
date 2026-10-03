// Bundles the agent into one ESM file for the runtime ISO (architecture section 3.3),
// with the license notices of everything it bundles next to it (section 11.3).
import { writeFileSync } from "node:fs";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noticesPath, thirdPartyNotices } from "./notices.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist/invisible-dots-agent.mjs");

const result = await build({
  entryPoints: [join(root, "src/bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "linked",
  // The bundle carries no license comments; THIRD_PARTY_NOTICES.txt carries the full texts.
  legalComments: "none",
  metafile: true,
  absWorkingDir: root,
  // Some CommonJS dependencies call require() at runtime, which an ES module does not have.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __idotsCreateRequire } from 'node:module';\nconst require = __idotsCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

const notices = thirdPartyNotices({ metafile: result.metafile, workingDir: root, repoRoot: join(root, "..", "..") });
writeFileSync(noticesPath(outfile), notices);
console.log(`wrote ${noticesPath(outfile)}`);
