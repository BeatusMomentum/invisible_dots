import { describe, expect, it } from "vitest";
import {
  AGENT_ROUTES,
  checkHomePath,
  checkOpenRouterKey,
  GUEST_PATHS,
  GUEST_PORT,
  identityPaths,
  OPENROUTER_KEY_RULE,
  truncateText,
  vmName,
} from "../src/browser.js";

describe("protocol constants", () => {
  it("match sections 3.4, 4.2 and 5", () => {
    expect(GUEST_PORT).toBe(1024);
    expect(GUEST_PATHS.agentdSocket).toBe("/run/invisible-dots/agentd.sock");
    expect(vmName("dot_abc")).toBe("invisible-dot-dot_abc");
    expect(AGENT_ROUTES.browserIdentity("a b")).toBe("/browser-identities/a%20b");
    expect(AGENT_ROUTES.browserIdentityFrame("a b")).toBe("/browser-identities/a%20b/frame");
    expect(AGENT_ROUTES.browserIdentityClose("a b")).toBe("/browser-identities/a%20b/close");
  });

  it("names the automation and tool routes, an automation id encoded as one path segment", () => {
    expect(AGENT_ROUTES.automations).toBe("/automations");
    expect(AGENT_ROUTES.automation("job 1/x")).toBe("/automations/job%201%2Fx");
    expect(AGENT_ROUTES.tools).toBe("/tools");
  });

  it("lays out an identity directory", () => {
    expect(identityPaths("shop-ab12cd")).toEqual({
      root: "/home/dot/browsers/shop-ab12cd",
      profile: "/home/dot/browsers/shop-ab12cd/profile",
      mcp: "/home/dot/browsers/shop-ab12cd/mcp",
    });
    expect(identityPaths("x", "/tmp/b/").profile).toBe("/tmp/b/x/profile");
  });
});

describe("checkOpenRouterKey", () => {
  it("takes a printable ASCII key without spaces, trimmed at its ends", () => {
    expect(checkOpenRouterKey("sk-or-v1-0123abcdEFGH~!")).toEqual({ ok: true, key: "sk-or-v1-0123abcdEFGH~!" });
    expect(checkOpenRouterKey("  sk-or-padded\n")).toEqual({ ok: true, key: "sk-or-padded" });
  });

  it("refuses what is not a string, what is empty, and what cannot travel in a header, without ever quoting the key", () => {
    for (const value of [undefined, null, 7, "", "  \t\n", " "]) {
      expect(checkOpenRouterKey(value)).toEqual({ ok: false, problem: "value must be a non-empty string" });
    }
    for (const bad of ["SECRET\nTAIL", "SECRET TAIL", "SECRETüTAIL", "SECRET\u0000TAIL", "SECRET\tTAIL", "SECRET\u007fTAIL"]) {
      const checked = checkOpenRouterKey(bad);
      expect(checked).toEqual({ ok: false, problem: `value is not an OpenRouter key: ${OPENROUTER_KEY_RULE}` });
      expect(JSON.stringify(checked)).not.toContain("SECRET");
    }
  });
});

describe("truncateText", () => {
  it("keeps a short text and cuts a long one to the limit, marker included", () => {
    expect(truncateText("short")).toBe("short");
    const cut = truncateText("x".repeat(20_000));
    expect(cut.length).toBeLessThanOrEqual(12_000);
    expect(cut.length).toBeGreaterThan(11_990);
    expect(cut).toMatch(/^x+\n\[\.\.\. truncated: \d+ more characters not shown\]$/);
    const omitted = Number(/truncated: (\d+)/.exec(cut)![1]);
    expect(cut.indexOf("\n[")).toBe(20_000 - omitted);
  });

  it("keeps both ends on request", () => {
    const text = `${"a".repeat(5000)}${"b".repeat(5000)}`;
    const cut = truncateText(text, 1000, "head-tail");
    expect(cut.length).toBeLessThanOrEqual(1000);
    expect(cut.startsWith("aaa")).toBe(true);
    expect(cut.endsWith("bbb")).toBe(true);
    expect(cut).toMatch(/\[\.\.\. truncated: \d+ characters not shown \.\.\.\]/);
  });
});

describe("checkHomePath: the guest paths the host API reads", () => {
  const ok = (raw: string) => {
    const checked = checkHomePath(raw);
    if (!checked.ok) throw new Error(`refused ${raw}: ${checked.problem}`);
    return checked.path;
  };
  const problem = (raw: unknown) => {
    const checked = checkHomePath(raw);
    if (checked.ok) throw new Error(`accepted ${String(raw)} as ${checked.path}`);
    return checked.problem;
  };

  it("takes absolute, relative and ~ paths and answers the normalized absolute one", () => {
    expect(ok("/home/dot")).toBe("/home/dot");
    expect(ok("/home/dot/")).toBe("/home/dot");
    expect(ok("~")).toBe("/home/dot");
    expect(ok("~/memory")).toBe("/home/dot/memory");
    expect(ok("memory/notes.md")).toBe("/home/dot/memory/notes.md");
    expect(ok("./memory//a/./b.md")).toBe("/home/dot/memory/a/b.md");
    expect(ok("/home//dot/./workspace/")).toBe("/home/dot/workspace");
    expect(ok(".")).toBe("/home/dot");
    expect(ok("a b/é.txt")).toBe("/home/dot/a b/é.txt");
  });

  it("refuses what is outside home, however it is written", () => {
    for (const raw of ["/", "/etc/passwd", "/home", "/home/dotter", "/home/dotter/x", "/home/other/x", "/root"]) {
      expect(problem(raw), raw).toBe("path must be inside /home/dot");
    }
  });

  it("refuses any .. segment instead of resolving it, even one that stays inside home", () => {
    for (const raw of ["..", "../x", "memory/../x", "/home/dot/memory/..", "~/..", "~/memory/../../etc", "/home/dot/a/../b", "/home/dot/../../etc"]) {
      expect(problem(raw), raw).toBe('path must not contain ".." segments');
    }
    // A name that merely contains dots is a name.
    expect(ok("memory/..hidden")).toBe("/home/dot/memory/..hidden");
    expect(ok("memory/a..b")).toBe("/home/dot/memory/a..b");
  });

  it("refuses an empty, non-string, NUL-carrying or over-long path", () => {
    expect(problem("")).toMatch(/non-empty/);
    expect(problem(undefined)).toMatch(/non-empty/);
    expect(problem(["/home/dot"])).toMatch(/non-empty/);
    expect(problem("a\0b")).toMatch(/NUL/);
    expect(problem(`/home/dot/${"x".repeat(4100)}`)).toMatch(/longer than 4096/);
  });
});
