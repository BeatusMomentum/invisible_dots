/**
 * Code copied from another project keeps its license. Every such file starts with a comment of the form
 *
 *   // Derived from <project> <path> at <commit>, <license>; changed: <what>.
 *
 * and this repository's THIRD_PARTY_NOTICES.md must have a section for <project>, whose heading is the project's
 * name. These checks keep the two together: a copied file without its notice, or a header that does not say what
 * changed (which Apache-2.0 requires and the other licenses make good practice), fails here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/** Tracked files and the new ones not yet tracked, so that a copied file is checked before it is committed. */
function sourceFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listed
    .split("\0")
    .filter((path) => /\.(?:ts|tsx|js|mjs|css|py|go)$/.test(path) && path !== "tests/repo/notices.test.ts");
}

function noticeProjects(): string[] {
  const notices = readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8").replace(/\r\n/g, "\n");
  return [...notices.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.trim());
}

/** The `Derived from` comment among the first lines of a file, comment markers stripped. */
function derivedHeader(path: string): string | null {
  const head = readFileSync(join(repo, path), "utf8").replace(/\r\n/g, "\n").split("\n").slice(0, 4);
  const line = head.find((candidate) => /^(?:\/\/|#|\/\*+|\*)\s*Derived from /.test(candidate));
  return line ? line.replace(/^(?:\/\/|#|\/\*+|\*)\s*/, "").replace(/\s*\*\/$/, "") : null;
}

describe("copied code and its notices", () => {
  const derived = sourceFiles().flatMap((path) => {
    const header = derivedHeader(path);
    return header === null ? [] : [{ path, header }];
  });
  const projects = noticeProjects();

  it("finds the files that say they derive from another project", () => {
    // If the scan stopped seeing them, every other check here would pass for nothing.
    expect(derived.length).toBeGreaterThan(0);
  });

  it.each(derived.map((d) => [d.path, d.header]))("%s names a project that has a section in THIRD_PARTY_NOTICES.md", (_path, header) => {
    expect(
      projects.some((project) => header!.startsWith(`Derived from ${project} `)),
      `"${header}" starts with none of the sections: ${projects.join(", ")}`,
    ).toBe(true);
  });

  it.each(derived.map((d) => [d.path, d.header]))("%s names its commit, its license and what it changed", (_path, header) => {
    expect(header).toMatch(/ at [0-9a-f]{7,40}, (?:MIT|Apache-2\.0|BSD-[23]-Clause|ISC); changed: \S.+\.$/);
  });
});
