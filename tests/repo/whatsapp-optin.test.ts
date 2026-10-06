/**
 * WhatsApp is an opt-in adapter over an unofficial client. These checks keep the three promises that make it
 * opt-in: the client is pinned to one exact release (it is a release candidate and the protocol moves under it),
 * only the one glue file knows it, and that file loads it when a connection opens, never when the server starts, so
 * a server that never links WhatsApp never loads it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

/** Every TypeScript source of the workspaces, tests and build output left out (the bundler script names the package too, on purpose). */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".next", "test", "docs_graphify", ".local"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe("the WhatsApp client", () => {
  it("is pinned to one exact version in the channels package and in the lock file", () => {
    const declared = (JSON.parse(read("packages/channels/package.json")) as { dependencies: Record<string, string> }).dependencies.baileys;
    expect(declared).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/baileys"]?.version).toBe(declared);
  });

  it("is declared by no other package: one owner of the dependency", () => {
    for (const where of ["apps", "packages"]) {
      for (const name of readdirSync(join(repo, where))) {
        const manifest = join(repo, where, name, "package.json");
        if (!existsSync(manifest) || where + "/" + name === "packages/channels") continue;
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        expect({ ...parsed.dependencies, ...parsed.devDependencies }, manifest).not.toHaveProperty("baileys");
      }
    }
  });

  it("is imported by the glue file alone, as types and by one dynamic import() when a connection opens", () => {
    const importing: string[] = [];
    for (const file of [...sources(join(repo, "apps")), ...sources(join(repo, "packages"))]) {
      const text = readFileSync(file, "utf8");
      if (!/["']baileys["']/.test(text)) continue;
      importing.push(relative(repo, file).split(sep).join("/"));
      for (const line of text.split("\n")) {
        if (!/from ["']baileys["']|import\(["']baileys["']\)/.test(line)) continue;
        // A static import is allowed only when it is erased: `import type`.
        if (/from ["']baileys["']/.test(line)) expect(line.trimStart(), `${file}: ${line}`).toMatch(/^import type /);
      }
    }
    expect(importing.sort()).toEqual(["packages/channels/src/whatsapp-baileys/auth-state.ts", "packages/channels/src/whatsapp-baileys/baileys.ts"]);
    const glue = read("packages/channels/src/whatsapp-baileys/baileys.ts");
    // One runtime import, in `connect`; the other mention is the type alias `typeof import("baileys")`, which is erased.
    expect(glue.match(/await import\(["']baileys["']\)/g)).toHaveLength(1);
  });

  it("stays out of the command bundle, because its dependency libsignal is GPL-3.0, and the notices say so", () => {
    expect(read("apps/cli/scripts/build.mjs")).toMatch(/external: \[[^\]]*"baileys"/);
    const notices = read("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("libsignal");
    expect(notices).toContain("GPL-3.0");
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { license?: string }> };
    expect(lock.packages["node_modules/libsignal"]?.license).toBe("GPL-3.0");
  });

  it("is turned on by INVISIBLE_DOTS_WHATSAPP=1 alone: the server composes the adapter from the environment", () => {
    const start = read("apps/api/src/start.ts");
    expect(start).toContain("ENV.WHATSAPP");
    expect(read("packages/shared/src/protocol.ts")).toContain('WHATSAPP: "INVISIBLE_DOTS_WHATSAPP"');
  });
});
