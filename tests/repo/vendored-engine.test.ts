/**
 * The engine under guest-runtime/engine/ is derived in part from Open
 * Multi-Agent (MIT). These checks keep the attribution whole: upstream's
 * license next to the code, byte for byte; its full text in the notices at
 * the repository root, with the notice of the library some imported text was
 * modelled on; and no npm dependency on upstream or anything else outside
 * this workspace.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const engine = join(repo, "guest-runtime", "engine");

const UPSTREAM_COMMIT = "3563a9312b304fffca49873c0dcf6c3b259a0f58";
const LICENSE_BLOB = "31f4e3eb40fecbc73d1a14a7f3cda0de278f1069";

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** The id git gives a file's content, after the LF normalisation a Windows checkout may undo. */
function blobId(bytes: Buffer): string {
  const content = Buffer.from(lf(bytes.toString("utf8")), "utf8");
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

describe("the vendored engine", () => {
  it("keeps upstream's LICENSE byte for byte", () => {
    expect(blobId(readFileSync(join(engine, "LICENSE")))).toBe(LICENSE_BLOB);
  });

  it("carries upstream's license text verbatim in the root notices, with context-chef's", () => {
    const notices = lf(readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8"));
    const license = lf(readFileSync(join(engine, "LICENSE"), "utf8")).trimEnd();
    expect(notices).toContain(license);
    expect(notices).toContain("`@context-chef/core` 4.2.1");
    expect(notices).toContain("Copyright (c) 2025 MyPrototypeWhat");
  });

  it("records the upstream commit and license blob in UPSTREAM.md", () => {
    const upstream = readFileSync(join(engine, "UPSTREAM.md"), "utf8");
    expect(upstream).toContain(UPSTREAM_COMMIT);
    expect(upstream).toContain(LICENSE_BLOB);
  });

  it("has no npm dependency outside this workspace", () => {
    const pkg = JSON.parse(readFileSync(join(engine, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
    expect(names.filter((n) => !n.startsWith("@invisible-dots/"))).toEqual([]);
  });
});
