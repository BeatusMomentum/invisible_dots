/**
 * WhatsApp is an opt-in adapter over an unofficial client, and the client is an opt-in install: Baileys depends on
 * libsignal, which is GPL-3.0, and the default npm install holds nothing GPL. These checks keep what makes that true: the
 * client is declared by no workspace and is in no default lock; it lives in its own folder with its own lock file, at
 * one exact version, every package with its integrity hash; one documented command installs it; and the one glue
 * file that loads it does so by path, when a connection opens, so neither the bundle nor a server that never links
 * WhatsApp holds or loads it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WHATSAPP_INSTALL_COMMAND, whatsappClientDir } from "../../packages/channels/src/whatsapp-baileys/client.js";
import { lockedPackages, packageName, type LockedPackage } from "./lock-licenses.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");
interface Manifest {
  private?: boolean;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
const manifest = (path: string) => JSON.parse(read(path)) as Manifest;
const CLIENT_FOLDER = "optional/whatsapp";

/** Every TypeScript source of the workspaces, tests and build output left out (the bundler script names the package too, on purpose). */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".next", "test", "test-optin", "docs_graphify", ".local"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe("the WhatsApp client is not in the default install", () => {
  it("is declared by no workspace and by no dependency list of the root: not regular, dev, optional or peer", () => {
    const manifests = ["package.json", "guest/image-builder/package.json"];
    for (const where of ["apps", "packages"]) {
      for (const name of readdirSync(join(repo, where))) if (existsSync(join(repo, where, name, "package.json"))) manifests.push(`${where}/${name}/package.json`);
    }
    expect(manifests.length).toBeGreaterThan(10);
    for (const path of manifests) {
      const parsed = manifest(path);
      for (const list of [parsed.dependencies, parsed.devDependencies, parsed.optionalDependencies, parsed.peerDependencies]) expect(list ?? {}, path).not.toHaveProperty("baileys");
    }
  });

  it("is outside every workspace, so `npm ci` at the root never reads its folder", () => {
    const patterns = manifest("package.json").workspaces ?? [];
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const matches = pattern.endsWith("/*") ? CLIENT_FOLDER.startsWith(pattern.slice(0, -1)) && CLIENT_FOLDER.split("/").length === pattern.split("/").length : pattern === CLIENT_FOLDER;
      expect(matches, `workspace pattern ${pattern}`).toBe(false);
    }
  });

  it("is in no package of the root lock file", () => {
    const names = lockedPackages(JSON.parse(read("package-lock.json"))).map((p) => packageName(p.path));
    expect(names).not.toContain("baileys");
    expect(names).not.toContain("libsignal");
  });
});

describe("the WhatsApp client is installed by one command, from its own pinned lock file", () => {
  const folder = manifest(`${CLIENT_FOLDER}/package.json`);
  const lock = JSON.parse(read(`${CLIENT_FOLDER}/package-lock.json`)) as { lockfileVersion: number; packages: Record<string, Omit<LockedPackage, "path"> & { dependencies?: Record<string, string> }> };

  it("pins Baileys to one exact version, which the lock file holds at that version", () => {
    expect(Object.keys(folder.dependencies ?? {})).toEqual(["baileys"]);
    const declared = folder.dependencies!.baileys!;
    expect(declared).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]?.dependencies?.baileys).toBe(declared);
    expect(lock.packages["node_modules/baileys"]?.version).toBe(declared);
    expect(folder.private).toBe(true);
  });

  it("has an integrity hash and a registry address for every package it installs", () => {
    const packages = lockedPackages(lock);
    expect(packages.length).toBeGreaterThan(20);
    for (const p of packages) {
      expect(p.integrity, p.path).toMatch(/^sha512-/);
      expect(p.resolved, p.path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
  });

  it("is installed by `npm run whatsapp:install`, a clean install of that lock file without install scripts", () => {
    expect(WHATSAPP_INSTALL_COMMAND).toBe("npm run whatsapp:install");
    expect(manifest("package.json").scripts?.["whatsapp:install"]).toBe(`npm ci --prefix ${CLIENT_FOLDER} --ignore-scripts --no-audit --no-fund`);
    expect(whatsappClientDir("/repo")).toBe(join("/repo", ...CLIENT_FOLDER.split("/")));
  });

  it("is the command the README, the architecture document and the notices tell a person to run", () => {
    for (const path of ["README.md", "docs/architecture.md", "THIRD_PARTY_NOTICES.md"]) expect(read(path), path).toContain("npm run whatsapp:install");
  });

  it("has its types checked and its tests run by commands of their own, which the default ones leave out", () => {
    const scripts = manifest("package.json").scripts ?? {};
    expect(scripts["typecheck:whatsapp"]).toContain("tsconfig.whatsapp.json");
    expect(scripts["test:whatsapp"]).toContain("vitest.whatsapp.config.ts");
    expect(read("vitest.config.ts")).not.toContain("test-optin");
    expect((JSON.parse(read("tsconfig.json")) as { include: string[] }).include.join(" ")).not.toContain("test-optin");
  });
});

describe("the adapter loads the client", () => {
  it("by one path, in one file, and no other source names the package", () => {
    const naming: string[] = [];
    for (const file of [...sources(join(repo, "apps")), ...sources(join(repo, "packages"))]) {
      if (/["']baileys["']/.test(readFileSync(file, "utf8"))) naming.push(relative(repo, file).split(sep).join("/"));
    }
    expect(naming).toEqual(["packages/channels/src/whatsapp-baileys/client.ts"]);
    const loader = read("packages/channels/src/whatsapp-baileys/client.ts");
    // One dynamic import, of a file URL; and the package name is only ever resolved from the client's folder.
    expect(loader.match(/await import\(/g)).toHaveLength(1);
    expect(loader).toContain("pathToFileURL(found.entry).href");
    expect(loader).toContain('createRequire(join(dir, "package.json")).resolve("baileys")');
  });

  it("is imported by no source of the workspaces, not even as types: they compile without the library", () => {
    for (const file of [...sources(join(repo, "apps")), ...sources(join(repo, "packages"))]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from ["']baileys["']|import\(["']baileys["']\)|require\(["']baileys["']\)/);
    }
  });

  it("is not in the command bundle, because libsignal is GPL-3.0, and the notices say so", () => {
    expect(read("apps/cli/scripts/build.mjs")).not.toMatch(/external: \[[^\]]*baileys/);
    const notices = read("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("libsignal");
    expect(notices).toContain("GPL-3.0");
    expect(notices).toContain("optional/whatsapp");
    const lock = JSON.parse(read(`${CLIENT_FOLDER}/package-lock.json`)) as { packages: Record<string, { license?: string }> };
    expect(lock.packages["node_modules/libsignal"]?.license).toBe("GPL-3.0");
  });

  it("is turned on by INVISIBLE_DOTS_WHATSAPP=1 alone: the server composes the adapter from the environment", () => {
    const start = read("apps/api/src/start.ts");
    expect(start).toContain("ENV.WHATSAPP");
    expect(read("packages/shared/src/protocol.ts")).toContain('WHATSAPP: "INVISIBLE_DOTS_WHATSAPP"');
  });
});
