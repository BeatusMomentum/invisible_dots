import { describe, expect, it } from "vitest";
import { AGENT_ROUTES, GUEST_PATHS, GUEST_PORT, identityPaths, vmName } from "../src/browser.js";

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
