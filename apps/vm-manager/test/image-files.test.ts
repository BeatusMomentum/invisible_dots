// Sanity checks of the shell scripts, units and pins the vm-manager depends on
// at runtime (virtualization/ and guest/image-builder/).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const builder = join(repo, "guest/image-builder");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const scripts = [...walk(builder), ...walk(join(repo, "virtualization"))].filter((path) => path.endsWith(".sh"));

// On Windows "bash" may resolve to WSL, which cannot read these paths; CI runs on Linux.
const bashUsable = process.platform !== "win32";

describe("shell scripts", () => {
  it("finds the scripts", () => {
    expect(scripts.map((path) => path.slice(repo.length + 1).replace(/\\/g, "/")).sort()).toEqual([
      "guest/image-builder/build-golden.sh",
      "guest/image-builder/build-runtime.sh",
      "guest/image-builder/builder/provision.sh",
      "guest/image-builder/lib.sh",
      "guest/image-builder/runtime/dot-desktop.sh",
      "guest/image-builder/runtime/install.sh",
      "virtualization/networking/ensure-network.sh",
    ]);
  });

  it.each(scripts)("%s has LF endings, strict mode and no non-ASCII", (path) => {
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("\r");
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(text)).toBe(true);
    if (!path.endsWith("lib.sh")) expect(text).toMatch(/^set -E?euo pipefail$/m);
  });

  it.skipIf(!bashUsable).each(scripts)("%s parses with bash -n", (path) => {
    execFileSync("bash", ["-n", path], { stdio: "pipe" });
  });
});

describe("guest units", () => {
  const unit = (name: string) => readFileSync(join(builder, "units", name), "utf8");

  it.each(["dot-desktop.service", "dot-agentd.service", "invisible-dots-agent.service"])("%s runs as dot with the display and uv's bin dir", (name) => {
    const text = unit(name);
    expect(text).not.toContain("\r");
    expect(text).toMatch(/^User=dot$/m);
    expect(text).toMatch(/^Environment=DISPLAY=:0$/m);
    expect(text).toMatch(/^Environment=PATH=\/home\/dot\/\.local\/bin:/m);
    expect(text).toMatch(/^RequiresMountsFor=\/opt\/invisible-dots$/m);
    expect(text).toMatch(/^Restart=on-failure$/m);
    expect(text).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  it("orders the agent after dot-agentd and the desktop", () => {
    expect(unit("invisible-dots-agent.service")).toMatch(/^After=.*dot-agentd\.service.*dot-desktop\.service/m);
    expect(unit("invisible-dots-agent.service")).toContain("ExecStart=/usr/local/bin/node /opt/invisible-dots/invisible-dots-agent.mjs");
  });

  it("starts Xvfb without TCP", () => {
    expect(readFileSync(join(builder, "runtime/dot-desktop.sh"), "utf8")).toContain('Xvfb "$display" -nolisten tcp');
  });
});

describe("pins", () => {
  it("pins the base image to a dated release and a SHA-256", () => {
    const base = JSON.parse(readFileSync(join(repo, "virtualization/images/base.json"), "utf8"));
    expect(base.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(base.url).toContain(`/release-${base.serial}/`);
    expect(base.sha256sums_url).toContain(`/release-${base.serial}/SHA256SUMS`);
    expect(base.local_name).toBe("noble-server-cloudimg-amd64.img");
  });

  it("pins Node 24, uv and the browser layer exactly", () => {
    const pins = JSON.parse(readFileSync(join(builder, "pins.json"), "utf8"));
    expect(pins.node.version).toMatch(/^24\./);
    for (const tool of [pins.node, pins.uv]) {
      expect(tool.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(tool.url).toContain(tool.version);
      expect(tool.url.endsWith(tool.shasums_entry)).toBe(true);
    }
    expect(pins.python_packages["invisible-playwright-mcp"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.python_packages["invisible-playwright"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.apt_packages).toEqual(expect.arrayContaining(["qemu-guest-agent", "xvfb", "imagemagick", "dbus-x11"]));
  });
});
