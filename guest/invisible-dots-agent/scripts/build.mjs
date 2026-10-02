// Bundles the agent into one ESM file for the runtime ISO (architecture section 3.3).
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "src/bin.ts")],
  outfile: join(root, "dist/invisible-dots-agent.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "linked",
  legalComments: "none",
  // Some CommonJS dependencies call require() at runtime, which an ES module does not have.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __idotsCreateRequire } from 'node:module';\nconst require = __idotsCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
