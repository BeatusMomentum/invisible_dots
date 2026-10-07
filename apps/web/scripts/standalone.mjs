// Finishes `next build` for `invisible-dots server`, which runs the web client
// as a child process: Next's standalone output holds the server and what it
// traced, but not the browser files (`.next/static`) or `public/`, which its
// own documentation says to copy next to it. apps/cli/src/web.ts looks for
// the result at the paths below.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
// The workspace root is Next's tracing root (next.config.ts), so the app sits at its own path inside the standalone tree.
const standalone = join(app, ".next", "standalone", "apps", "web");

if (!existsSync(join(standalone, "server.js"))) {
  throw new Error(`next build left no ${join(standalone, "server.js")}: is output "standalone" set in next.config.ts?`);
}
for (const [from, to] of [
  [join(app, ".next", "static"), join(standalone, ".next", "static")],
  [join(app, "public"), join(standalone, "public")],
]) {
  rmSync(to, { recursive: true, force: true });
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}
