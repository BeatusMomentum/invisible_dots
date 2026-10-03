// The files this package reads at run time relative to the running module,
// which a bundle that contains it must carry next to itself:
// - the SQL migrations (migrate.ts looks in ./migrations),
// - PGlite's WebAssembly module, its data file and initdb, which PGlite
//   loads with `new URL("./<file>", import.meta.url)`.
// Both bundles that contain the control plane (the API's bin and the
// invisible-dots command) call this, so the list lives with the package that
// needs the files.
import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const PGLITE_RUNTIME_FILES = ["pglite.wasm", "pglite.data", "initdb.wasm"];

/** Copy the migrations and the PGlite runtime files into `dist`. */
export function copyDatabaseRuntimeFiles(dist) {
  cpSync(join(packageRoot, "src", "migrations"), join(dist, "migrations"), { recursive: true });
  // Resolved from this package, which is the one that depends on PGlite.
  const requireFromHere = createRequire(join(packageRoot, "package.json"));
  const pgliteDist = dirname(requireFromHere.resolve("@electric-sql/pglite"));
  for (const file of PGLITE_RUNTIME_FILES) cpSync(join(pgliteDist, file), join(dist, file));
  console.log(`copied the migrations and ${PGLITE_RUNTIME_FILES.join(", ")} to ${dist}`);
}
