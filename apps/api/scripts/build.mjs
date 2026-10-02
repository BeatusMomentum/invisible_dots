// Bundles invisible-dots-server into one ESM file. The workspace packages are
// TypeScript sources, so the server cannot run from them with plain node; the
// bundle can. The SQL migrations are copied next to it, where the database
// package looks for them (./migrations relative to the running module).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(dist, "invisible-dots-server.mjs"),
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

cpSync(join(root, "..", "..", "packages", "database", "src", "migrations"), join(dist, "migrations"), { recursive: true });
console.log("copied migrations to dist/migrations");
