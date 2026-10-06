/**
 * Nothing under the GPL is installed by default. `npm ci` installs what package-lock.json says, so the lock is
 * scanned: no package of it may need a GPL or AGPL license (the WhatsApp client's dependency libsignal is GPL-3.0 and
 * lives in its own opt-in folder, optional/whatsapp), and a package whose license the lock does not state is not
 * allowed to hide one. LGPL is not GPL; the few LGPL packages that remain (the image library Next.js may install, as
 * prebuilt binaries) are named here, and THIRD_PARTY_NOTICES.md says so.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lockedPackages, mentionsLgpl, needsStrongCopyleft, packageName } from "./lock-licenses.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const lockOf = (path: string) => lockedPackages(JSON.parse(readFileSync(join(repo, path), "utf8")));
const rootLock = lockOf("package-lock.json");
const optInLock = lockOf("optional/whatsapp/package-lock.json");

describe("the license scan of a lock file", () => {
  it("flags a package that needs GPL or AGPL, in any version and wording, and lets an alternative that is not GPL through", () => {
    for (const gpl of ["GPL-3.0", "GPL-2.0-only", "GPL-3.0-or-later", "AGPL-3.0", "MIT AND GPL-2.0-only", "(GPL-2.0 OR GPL-3.0)", "GPL-2.0 WITH Classpath-exception-2.0"]) {
      expect(needsStrongCopyleft(gpl), gpl).toBe(true);
    }
    for (const fine of ["MIT", "(MIT OR GPL-3.0)", "(BSD-2-Clause OR GPL-2.0)", "LGPL-3.0-or-later", "Apache-2.0 AND LGPL-3.0-or-later AND MIT", "ISC"]) {
      expect(needsStrongCopyleft(fine), fine).toBe(false);
    }
    expect(mentionsLgpl("Apache-2.0 AND LGPL-3.0-or-later")).toBe(true);
    expect(mentionsLgpl("GPL-3.0")).toBe(false);
  });

  it("would catch libsignal: the opt-in lock holds a GPL-3.0 package that the scan flags", () => {
    const flagged = optInLock.filter((p) => p.license !== undefined && needsStrongCopyleft(p.license)).map((p) => packageName(p.path));
    expect(flagged).toEqual(["libsignal"]);
  });
});

describe("a default install (npm ci on package-lock.json)", () => {
  it("installs no package that needs a GPL or AGPL license", () => {
    const flagged = rootLock.filter((p) => p.license !== undefined && needsStrongCopyleft(p.license)).map((p) => `${packageName(p.path)} ${p.version}: ${p.license}`);
    expect(flagged).toEqual([]);
  });

  it("states a license for every package it installs, so none can hide a GPL one (only the workspaces' own links have none)", () => {
    const unstated = rootLock.filter((p) => p.license === undefined && p.link !== true).map((p) => p.path);
    expect(unstated).toEqual([]);
    for (const p of rootLock.filter((p) => p.link)) expect(p.path, "a link is one of this repository's own workspaces").toMatch(/^node_modules\/@invisible-dots\//);
  });

  it("installs LGPL packages only among the prebuilt image libraries Next.js may fetch, which the notices name", () => {
    const lgpl = rootLock.filter((p) => p.license !== undefined && mentionsLgpl(p.license)).map((p) => packageName(p.path));
    expect(lgpl.length).toBeGreaterThan(0);
    for (const name of lgpl) expect(name, name).toMatch(/^@img\/sharp(-libvips)?-/);
    const notices = readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("LGPL-3.0");
    expect(notices).toContain("@img/sharp");
  });

  it("holds none of the WhatsApp client or of what only it needs", () => {
    const names = new Set(rootLock.map((p) => packageName(p.path)));
    for (const name of ["baileys", "libsignal", "whatsapp-rust-bridge", "curve25519-js"]) expect(names.has(name), name).toBe(false);
  });
});
