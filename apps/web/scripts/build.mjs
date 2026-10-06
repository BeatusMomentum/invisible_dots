// `npm run build --workspace @invisible-dots/web`: `next build`, then standalone.mjs. It is a script of its own and
// not an `&&` in package.json so that `invisible-dots setup --all` can run exactly these steps with plain node: npm
// is a .cmd file on Windows, which Node starts only through a shell, and the CLI never starts a program through one.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const next = createRequire(join(app, "package.json")).resolve("next/dist/bin/next");

for (const args of [[next, "build", "--webpack"], [join(app, "scripts", "standalone.mjs")]]) {
  const result = spawnSync(process.execPath, args, { cwd: app, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
