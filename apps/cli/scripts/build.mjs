// Bundles the invisible-dots command into one ESM file that plain node runs
// (the workspace packages are TypeScript sources). `invisible-dots server`
// is in the same bundle, so the database's run-time files go next to it.
// The pinned Windows QEMU installer (virtualization/qemu/windows.json) is
// imported as JSON and so is inside the bundle.
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyDatabaseRuntimeFiles } from "../../../packages/database/scripts/runtime-files.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(dist, "invisible-dots.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  // pg loads its optional native binding with require(); it is never installed here.
  external: ["pg-native"],
  banner: {
    // CommonJS dependencies inside an ESM bundle still call require().
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});

copyDatabaseRuntimeFiles(dist);
