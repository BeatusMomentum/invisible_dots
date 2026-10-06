import { describe, expect, it } from "vitest";
import {
  AGENT_ROUTES,
  checkOpenRouterKey,
  GUEST_PATHS,
  GUEST_PORT,
  IDENTITY_ERROR_STATUS,
  identityPaths,
  isIdentityAnswer,
  OPENROUTER_KEY_RULE,
  PREPARE_SLEEP_TIMEOUT_MS,
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
    // Section 9.5: the engine's steps of a prepare-sleep (20 s of grace, 5 s of cancel wait, a 30 s browser close) fit inside.
    expect(PREPARE_SLEEP_TIMEOUT_MS).toBe(60_000);
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

describe("identity error answers", () => {
  it("name the status of every code the engine answers on the identity routes", () => {
    expect(IDENTITY_ERROR_STATUS).toEqual({
      invalid: 400,
      not_found: 404,
      limit: 409,
      not_open: 409,
      busy: 503,
      crashed: 502,
      frame_failed: 502,
    });
  });

  it("recognize an answer only by its code and its status together", () => {
    expect(isIdentityAnswer("busy", 503)).toBe(true);
    expect(isIdentityAnswer("crashed", 502)).toBe(true);
    expect(isIdentityAnswer("busy", 502)).toBe(false);
    expect(isIdentityAnswer("guest_error", 502)).toBe(false);
    expect(isIdentityAnswer("toString", 0)).toBe(false);
    expect(isIdentityAnswer(undefined, 503)).toBe(false);
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
