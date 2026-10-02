import { describe, expect, it } from "vitest";
import { AGENT_ROUTES, domainName, ENV, GUEST_PATHS, hostPaths, identityPaths, VSOCK_PORT } from "../src/index.js";

describe("protocol constants", () => {
  it("match sections 4.2 and 5", () => {
    expect(VSOCK_PORT).toBe(1024);
    expect(GUEST_PATHS.database).toBe("/home/dot/state/dot.db");
    expect(GUEST_PATHS.agentdSocket).toBe("/run/invisible-dots/agentd.sock");
    expect(domainName("dot_abc")).toBe("invisible-dot-dot_abc");
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

describe("hostPaths", () => {
  it("uses the defaults of section 3.2", () => {
    const paths = hostPaths({});
    expect(paths.vmDisk("dot_1")).toBe("/var/lib/invisible-dots/vms/dot_1/disk.qcow2");
    expect(paths.vmSeed("dot_1")).toBe("/var/lib/invisible-dots/vms/dot_1/seed.iso");
    expect(paths.vmSerialLog("dot_1")).toBe("/var/lib/invisible-dots/vms/dot_1/serial.log");
    expect(paths.goldenImage("3")).toBe("/var/lib/invisible-dots/images/golden-3.qcow2");
    expect(paths.runtimeImage("3")).toBe("/var/lib/invisible-dots/images/runtime-3.iso");
    expect(paths.bridgeSocket("dot_1")).toBe("/run/invisible-dots/dot-dot_1.sock");
    expect(paths.masterKey).toBe("/etc/invisible-dots/master.key");
    expect(paths.apiToken).toBe("/etc/invisible-dots/api.token");
  });

  it("honours the environment overrides", () => {
    const paths = hostPaths({
      [ENV.STATE_DIR]: "/srv/dots/",
      [ENV.RUN_DIR]: "/tmp/run",
      [ENV.CONFIG_DIR]: "/opt/conf",
    });
    expect(paths.vmDir("d")).toBe("/srv/dots/vms/d");
    expect(paths.bridgeSocket("d")).toBe("/tmp/run/dot-d.sock");
    expect(paths.serverEnv).toBe("/opt/conf/server.env");
  });
});
