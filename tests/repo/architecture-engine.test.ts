/**
 * docs/architecture.md describes the engine in invisible_engine_dots/ and the
 * guest image that carries it. These checks keep the parts of it that can be
 * read from the code equal to the code: the engine's tool table (section 8.3)
 * is the permission table of nanobot/dots/permissions.py, every engine file the
 * documents name exists, and no document names the engine this one replaced.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSIONS } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const engine = join(repo, "invisible_engine_dots");

function read(path: string): string {
  return readFileSync(join(repo, path), "utf8").replace(/\r\n/g, "\n");
}

const DOCS = ["docs/architecture.md", "README.md", "docs/guide.md", "THIRD_PARTY_NOTICES.md", "guest/image-builder/README.md"];

/** The section of the architecture document that starts at `heading`, up to the next heading of the same level. */
function section(text: string, heading: string): string {
  const level = heading.split(" ")[0]!;
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = text.indexOf(`\n${level} `, start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("the architecture document and the engine", () => {
  const architecture = read("docs/architecture.md");

  it("lists in section 8.3 exactly the tools of the engine's permission table, with their permissions", () => {
    const code = read("invisible_engine_dots/nanobot/dots/permissions.py");
    const table = new Map(
      [...code.matchAll(/^\s+"(\w+)": ToolEntry\("([\w.]+)"/gm)].map((m) => [m[1]!, m[2]!] as const),
    );
    expect(table.size).toBeGreaterThan(0);
    const offered = section(architecture, "### 8.3 Tools");
    const documented = new Map(
      [...offered.matchAll(/^\| `(\w+)` \| `([\w.]+)` \|/gm)].map((m) => [m[1]!, m[2]!] as const),
    );
    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(table));
  });

  it("uses only permissions that packages/shared names, in the engine's table and in the document", () => {
    // packages/shared is where a Dot's config is checked: a permission outside its list can never be allowed.
    const known = new Set<string>(PERMISSIONS);
    const code = read("invisible_engine_dots/nanobot/dots/permissions.py");
    const used = [...code.matchAll(/^\s+"\w+": ToolEntry\("([\w.]+)"/gm)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const permission of used) expect(known.has(permission), `engine: ${permission}`).toBe(true);

    const tools = section(architecture, "### 8.3 Tools");
    const documented = [...tools.matchAll(/^\| .+? \| `([a-z.]+)` \|/gm)].map((m) => m[1]!);
    expect(documented.length).toBe(used.length);
    for (const permission of documented) expect(known.has(permission), `section 8.3: ${permission}`).toBe(true);

    // The names that no tool can exercise are in no list of section 7 or 8.3 either.
    const configuration = section(architecture, "## 7. Dot configuration");
    for (const gone of ["web.fetch", "web.search", "web.*", "subagents", "message.send", "memory.write"]) {
      expect(configuration, gone).not.toContain(gone);
      expect(tools, gone).not.toContain(gone);
    }
  });

  it("names the engine files that exist", () => {
    const named = new Set(
      [...architecture.matchAll(/`((?:invisible_engine_dots\/)?nanobot\/[A-Za-z0-9_./]+\.(?:py|md))`/g)].map((m) => m[1]!),
    );
    expect(named.size).toBeGreaterThan(5);
    for (const path of named) {
      const file = path.startsWith("invisible_engine_dots/") ? path.slice("invisible_engine_dots/".length) : path;
      expect(existsSync(join(engine, file)), path).toBe(true);
    }
  });

  it("names the guest image files that exist", () => {
    const named = new Set(
      [...architecture.matchAll(/`((?:guest\/image-builder\/)?builder\/[A-Za-z0-9_.-]+)`/g)].map((m) => m[1]!),
    );
    expect(named.size).toBeGreaterThan(0);
    for (const path of named) {
      const file = path.startsWith("guest/") ? path : `guest/image-builder/${path}`;
      expect(existsSync(join(repo, file)), path).toBe(true);
    }
  });
});

describe("the documents", () => {
  it.each(DOCS)("%s names no OpenClaw", (path) => {
    expect(read(path)).not.toMatch(/openclaw/i);
  });

  it("describe the engine's process and its interpreter the way the unit runs them", () => {
    const unit = read("guest/image-builder/units/invisible-dots-agent.service");
    expect(unit).toContain("ExecStart=/opt/invisible-dots-engine/bin/python -I -B -m nanobot");
    expect(read("docs/architecture.md")).toContain("/opt/invisible-dots-engine/bin/python -I -B -m nanobot");
    expect(read("guest/image-builder/README.md")).toContain("/opt/invisible-dots-engine/bin/python -I -B -m nanobot");
  });
});
