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
import { BUNDLE_OPTIONS } from "./bundle-options.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  ...BUNDLE_OPTIONS,
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(dist, "invisible-dots.mjs"),
  logLevel: "info",
});

copyDatabaseRuntimeFiles(dist);
