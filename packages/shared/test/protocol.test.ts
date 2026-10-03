import { describe, expect, it } from "vitest";
import { AGENT_ROUTES, GUEST_PATHS, GUEST_PORT, identityPaths, truncateText, vmName } from "../src/browser.js";

describe("protocol constants", () => {
  it("match sections 3.4, 4.2 and 5", () => {
    expect(GUEST_PORT).toBe(1024);
    expect(GUEST_PATHS.database).toBe("/home/dot/state/dot.db");
    expect(GUEST_PATHS.agentdSocket).toBe("/run/invisible-dots/agentd.sock");
    expect(vmName("dot_abc")).toBe("invisible-dot-dot_abc");
    expect(AGENT_ROUTES.browserIdentity("a b")).toBe("/browser-identities/a%20b");
  });

  it("lays out an identity directory", () => {
    expect(identityPaths("shop-ab12cd")).toEqual({
      root: "/home/dot/browsers/shop-ab12cd",
      profile: "/home/dot/browsers/shop-ab12cd/profile",
      mcp: "/home/dot/browsers/shop-ab12cd/mcp",
      metadata: "/home/dot/browsers/shop-ab12cd/metadata.json",
    });
    expect(identityPaths("x", "/tmp/b/").profile).toBe("/tmp/b/x/profile");
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
