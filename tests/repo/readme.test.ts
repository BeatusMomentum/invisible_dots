/**
 * What the README states as facts must stay the facts of the code. The prose gates cannot tell that a command was
 * renamed, a default moved or a section was retitled, so the statements that name something the code owns are
 * compared with it here: the links into the architecture and within the page, the commands of the table and their
 * flags, the environment variables, and the numbers (defaults, limits, lead times) the text gives.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIFECYCLE_OPTIONS } from "../../apps/scheduler/src/lifecycle.js";
import { USAGE } from "../../apps/cli/src/cli.js";
import { ARGUMENTS_MAX } from "../../packages/channels/src/approval-text.js";
import { ENV, MAX_HOST_FILE_BYTES, parseDotConfig } from "../../packages/shared/src/index.js";
import { PRESET_IDS, PRESETS } from "../../apps/web/src/lib/permission-presets.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8").replace(/\r\n/g, "\n");
const readme = read("README.md");
const architecture = read("docs/architecture.md");

/** GitHub's anchor of a heading: lower case, punctuation dropped, spaces to hyphens. */
function anchorOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}

function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = !fenced ? /^#{1,6}\s+(.*)$/.exec(line) : null;
    if (heading) anchors.add(anchorOf(heading[1]!));
  }
  return anchors;
}

describe("the README's links", () => {
  it("into docs/architecture.md land on a heading that exists", () => {
    const anchors = anchorsOf(architecture);
    const links = [...readme.matchAll(/docs\/architecture\.md#([\w-]+)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) expect(anchors.has(link), `docs/architecture.md has no heading for #${link}`).toBe(true);
  });

  it("within the page land on a heading that exists", () => {
    const anchors = anchorsOf(readme);
    const links = [...readme.matchAll(/\]\(#([\w-]+)\)|href="#([\w-]+)"/g)].map((match) => (match[1] ?? match[2])!);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) expect(anchors.has(link), `README.md has no heading for #${link}`).toBe(true);
  });

  it("to files of the repository name files that exist", () => {
    const paths = [...readme.matchAll(/\]\((?!https?:|#)([^)#\s]+)(?:#[^)\s]*)?\)/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) expect(() => readFileSync(join(repo, path)), path).not.toThrow();
  });
});

describe("the README's table of commands", () => {
  const rows = readme
    .split("\n")
    .filter((line) => /^\| `invisible-dots /.test(line))
    .map((line) => /^\| `([^`]+)`/.exec(line)![1]!);

  it("lists only commands and flags the command line has", () => {
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const row of rows) {
      const words = row.split(/\s+/).slice(1);
      const command = words[0]!;
      expect(USAGE, row).toContain(`invisible-dots ${command}`);
      if (["channel", "computer", "browser", "secret"].includes(command)) {
        expect(USAGE, row).toContain(`invisible-dots ${command} ${words[1]}`);
      }
      for (const flag of row.match(/--[a-z-]+/g) ?? []) expect(USAGE, `${row}: ${flag}`).toContain(flag);
    }
  });
});

describe("the README's environment variables", () => {
  const table = readme.slice(readme.indexOf("<summary>The environment variables the host reads</summary>"));
  const listed = [...table.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((match) => match[1]!);

  it("are every one the host reads from its environment, except the one it sets for its own child", () => {
    const owned = Object.values(ENV).filter((name) => name.startsWith("INVISIBLE_DOTS_") || name === "DATABASE_URL");
    const internal: string[] = [ENV.WEB_PARENT_PID];
    for (const name of owned) {
      if (internal.includes(name)) expect(listed, name).not.toContain(name);
      else expect(listed, name).toContain(name);
    }
  });

  it("name only variables the code reads", () => {
    // The debug switch is read where the server starts; every other name is one of ENV.
    const known = new Set([...Object.values(ENV), "INVISIBLE_DOTS_DEBUG"]);
    for (const name of listed) {
      expect(known.has(name), `${name} is not a variable of ENV`).toBe(true);
    }
    expect(read("apps/api/src/start.ts")).toContain("INVISIBLE_DOTS_DEBUG");
  });
});

describe("the README's account of the web UI", () => {
  it("gives each permission preset of the Create a Dot page with the words the page uses", () => {
    for (const id of PRESET_IDS) {
      const { label, description } = PRESETS[id];
      expect(readme, id).toContain(`| ${label} | ${description} |`);
    }
  });
});

describe("the numbers the README gives", () => {
  const config = parseDotConfig("name: a\ngoal: b\nmodel: { provider: openrouter, id: x/y }\n");
  // The text with its line breaks and quote marks folded into spaces, so a reflow of a paragraph breaks nothing.
  const flat = readme.replace(/\s*\n(?:> ?)?\s*/g, " ");

  it("are the defaults of the configuration", () => {
    expect(config.computer.idle_timeout).toBe("15m");
    expect(flat).toContain("`idle_timeout`, 15 minutes in the sample");
    expect(config.browser.identities.max_open).toBe(3);
    expect(flat).toContain("`max_open` (default 3)");
    expect(config.browser.identities.max_identities).toBe(20);
    expect(flat).toContain("`max_identities` exist (default 20)");
    expect(config.computer.memory).toBe("4gb");
    expect(config.computer.disk).toBe("40gb");
    expect(flat).toContain("(40 GB in the sample)");
  });

  it("are the lead time of the automations' wake, the size of a file the host shows and the length of an approval's arguments", () => {
    expect(DEFAULT_LIFECYCLE_OPTIONS.automationWakeLeadMs).toBe(90_000);
    expect(flat).toContain("(90 seconds ahead by default)");
    expect(MAX_HOST_FILE_BYTES).toBe(16 * 1024 * 1024);
    expect(flat).toContain("at most 16 MiB");
    expect(ARGUMENTS_MAX).toBe(300);
    expect(flat).toContain("the arguments cut to 300 characters");
  });

  it("say a computer starts for its automations, and that a person's stop is the one thing that keeps it off", () => {
    expect(flat).not.toMatch(/automations?[^.]*(skipped|only while it is on|has to stay on)/i);
    expect(flat).toContain("the control plane starts the computer for them");
    expect(flat).toContain("stays off, and its automations are paused until you start it again");
  });
});
