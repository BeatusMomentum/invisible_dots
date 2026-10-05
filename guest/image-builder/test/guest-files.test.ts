// Checks of the files that run inside the guest. A mistake in them shows up
// only inside a booted VM, minutes into a build or on every Dot's boot, so
// the cheap ones are caught here.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILDER_PYTHON_LOCK, defaultAssetRoot, GUEST_ASSETS, GUEST_UNITS, unitAsset } from "../src/assets.js";
import { parsePythonLock } from "../src/python-lock.js";

const root = defaultAssetRoot();
const text = (relative: string) => readFileSync(join(root, relative), "utf8");
const scripts = GUEST_ASSETS.filter((path) => path.endsWith(".sh"));

/**
 * Whether a bash that can read this checkout's paths is on PATH. On a
 * Windows host "bash" can be WSL's launcher, which cannot open C:\ paths;
 * probing for that is a capability check, not a platform check.
 */
function bashCanRead(path: string): boolean {
  try {
    execFileSync("bash", ["-n", path], { stdio: "pipe", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
const bashUsable = bashCanRead(join(root, "runtime", "dot-desktop.sh"));

describe("guest files", () => {
  it("lists every guest script", () => {
    expect([...scripts].sort()).toEqual(["builder/build-engine-env.sh", "builder/provision.sh", "runtime/dot-desktop.sh", "runtime/install.sh"]);
  });

  it.each(GUEST_ASSETS)("%s is LF-only ASCII and says nothing about vsock or libvirt", (path) => {
    const content = text(path);
    expect(content).not.toContain("\r");
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(content)).toBe(true);
    expect(content).not.toMatch(/vsock|libvirt|virsh/i);
  });

  it.each(scripts)("%s runs in bash strict mode", (path) => {
    const content = text(path);
    expect(content.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(content).toMatch(/^set -E?euo pipefail$/m);
  });

  it.skipIf(!bashUsable).each(scripts)("%s parses with bash -n", (path) => {
    execFileSync("bash", ["-n", join(root, path)], { stdio: "pipe" });
  });

  it("provision.sh records the engine line of `invisible-playwright version` as browser-engine", () => {
    // The first line of that command is the wrapper's own version, which the
    // manifest already has as invisible-playwright; the end-to-end run found
    // the manifest recording it a second time as the browser engine.
    const content = text("builder/provision.sh");
    expect(content).not.toMatch(/version \| sed -n 1p/);
    expect(content).toContain('component browser-engine "$engine_version"');
  });

  /**
   * The sed program of provision.sh's engine line, run as the guest runs it
   * against the output of `invisible-playwright version` (the format of
   * invisible_playwright's cli.py), so a change on either side shows here
   * and not minutes into an image build.
   */
  const engineSed = (() => {
    const match = /engine_version="\$\(as_dot "[^"]+" version \| sed -n '([^']+)'\)"/.exec(text("builder/provision.sh"));
    if (!match) throw new Error("provision.sh no longer reads the engine with `version | sed -n '...'`");
    return match[1]!;
  })();
  const runSed = (input: string) => execFileSync("bash", ["-c", `sed -n '${engineSed}'`], { input, encoding: "utf8" });

  it.skipIf(!bashUsable)("the engine sed picks the engine line of the real `version` output, and nothing from output without one", () => {
    const sample = [
      "invisible_playwright 0.25.7",
      "invisible_core       34.31.0   (declared: ==34.31.0)",
      "engine               firefox-34  Firefox 151.0  build 20260920230044",
      "seal                 0123456789ab  [package]",
      "cache                /home/dot/.cache/invisible-playwright",
      "",
    ].join("\n");
    expect(runSed(sample)).toBe("firefox-34  Firefox 151.0  build 20260920230044\n");
    expect(runSed("invisible_playwright 0.25.7\nseal                 0123456789ab  [package]\n")).toBe("");
  });
});

describe("the sudo grants (architecture section 4.1)", () => {
  it("the builder seed gives dot and dotengine no sudo rule, and the provisioner removes any the image had", () => {
    const builder = text("builder/user-data.yaml");
    expect(builder).toContain("  - name: dot\n");
    expect(builder).toContain("  - name: dotengine\n");
    expect(builder.match(/^\s*sudo:.*$/gm)).toEqual(["    sudo: false", "    sudo: false"]);
    // provision.sh runs as root and reaches dot through root's own sudo -u.
    expect(text("builder/provision.sh")).toContain("rm -f /etc/sudoers.d/90-cloud-init-users");
  });
});

describe("the MCP server's Python environment", () => {
  const provision = text("builder/provision.sh");

  it("is installed from the hashed lock on the seed, never resolved from the index", () => {
    expect(provision).toContain('install -m 0644 "$payload/$PYTHON_LOCK" "$mcp_lock"');
    expect(provision).toContain('as_dot uv pip install --python "$mcp_env/bin/python" --require-hashes -r "$mcp_lock"');
    expect(provision).not.toMatch(/uv tool install/);
    expect(provision).toContain('as_dot "$mcp_env/bin/invisible-playwright" fetch');
  });

  it("the lock in this checkout pins every package with hashes, both top-level packages included", () => {
    const lock = parsePythonLock(text(BUILDER_PYTHON_LOCK));
    expect(lock.mcpVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.playwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages.size).toBeGreaterThan(10);
  });
});

describe("guest units", () => {
  it.each(GUEST_UNITS)("%s runs with the display and uv's bin dir, as dot or the engine's own user", (name) => {
    const unit = text(unitAsset(name));
    expect(unit).toMatch(name === "invisible-dots-agent.service" ? /^User=dotengine$/m : /^User=dot$/m);
    expect(unit).toMatch(/^Environment=DISPLAY=:0$/m);
    expect(unit).toMatch(/^Environment=PATH=\/home\/dot\/\.local\/bin:/m);
    expect(unit).toMatch(/^RequiresMountsFor=\/opt\/invisible-dots$/m);
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  it("starts dot-agentd from the runtime disk without overriding its TCP 1024 listener", () => {
    const unit = text(unitAsset("dot-agentd.service"));
    expect(unit).toContain("ExecStart=/opt/invisible-dots/bin/dot-agentd\n");
    expect(unit).toContain("TCP port 1024");
    // The default (all guest addresses, port 1024) is what QEMU's forward reaches; a
    // loopback-only override here would make every Dot unreachable.
    expect(unit).not.toMatch(/INVISIBLE_DOTS_AGENTD_LISTEN|--listen/);
  });

  it("orders the agent after dot-agentd and the desktop", () => {
    const unit = text(unitAsset("invisible-dots-agent.service"));
    expect(unit).toMatch(/^After=.*dot-agentd\.service.*dot-desktop\.service/m);
  });

  it("starts the Python engine as dotengine from its venv, isolated, with its state and sockets named", () => {
    const unit = text(unitAsset("invisible-dots-agent.service"));
    // -I: no PYTHON* variable and no user site; -B: the runtime disk is read-only.
    expect(unit).toContain("ExecStart=/opt/invisible-dots-engine/bin/python -I -B -m nanobot\n");
    expect(unit).toMatch(/^User=dotengine$/m);
    expect(unit).toMatch(/^Group=dotengine$/m);
    expect(unit).toMatch(/^UMask=0002$/m);
    expect(unit).toContain("Environment=HOME=/home/dotengine\n");
    expect(unit).toContain("Environment=TIKTOKEN_CACHE_DIR=/opt/invisible-dots-engine/share/tiktoken\n");
    expect(unit).toContain("Environment=INVISIBLE_DOTS_ENGINE_STATE=/home/dotengine/state\n");
    expect(unit).toContain("Environment=INVISIBLE_DOTS_AGENT_SOCKET=/run/invisible-dots-agent/agent.sock\n");
    expect(unit).toContain("Environment=INVISIBLE_DOTS_AGENTD_SOCKET=/run/invisible-dots/agentd.sock\n");
    expect(unit).toContain("Environment=INVISIBLE_DOTS_AGENTD_BIN=/opt/invisible-dots/bin/dot-agentd\n");
    expect(unit).toContain("Environment=INVISIBLE_DOTS_WORKSPACE=/home/dot/workspace\n");
    // It needs no privilege and may leave no core file: the key lives in its memory (architecture 4.3).
    expect(unit).toMatch(/^NoNewPrivileges=yes$/m);
    expect(unit).toMatch(/^LimitCORE=0$/m);
    expect(unit).toMatch(/^TimeoutStopSec=30$/m);
    // No key, ever, in the unit's environment, and no sudo or installer of any kind.
    const settings = unit.split("\n").filter((line) => !line.startsWith("#")).join("\n");
    expect(settings).not.toMatch(/API_KEY|NODE_ENV|sudo|INSTALLER/);
  });

  it("gives each socket a directory only its two users reach, and dotengine no root command", () => {
    const install = text("runtime/install.sh");
    expect(install).toContain("d /run/invisible-dots 2750 dot dotengine -");
    expect(install).toContain("d /run/invisible-dots-agent 2750 dotengine dot -");
    expect(install).toContain("install -d -o dotengine -g dotengine -m 0700 /home/dotengine/state");
    // No sudoers rule and no config directory are written: the engine's config lives in its database.
    expect(install).not.toMatch(/visudo|NOPASSWD|sudoers\.d|\/etc\/invisible-dots\/[a-z]+\//);
    expect(text("builder/user-data.yaml")).toMatch(/- name: dotengine\n[\s\S]*?groups: \[dot\]/);
  });

  it("install.sh refuses a golden image without the engine's environment", () => {
    const install = text("runtime/install.sh");
    expect(install).toContain("[ -x /opt/invisible-dots-engine/bin/python ] || die ");
    expect(install).toContain("a golden image from before the nanobot engine");
  });

  it("install.sh installs exactly the units the runtime disk carries", () => {
    expect(text("runtime/install.sh")).toContain(`units=(${GUEST_UNITS.join(" ")})`);
  });
});

describe("the desktop", () => {
  it("starts Xvfb without a TCP listener, so X needs no guest firewall", () => {
    expect(text("runtime/dot-desktop.sh")).toContain('Xvfb "$display" -nolisten tcp');
  });
});

describe("the provisioner", () => {
  const provision = text("builder/provision.sh");

  it("reports progress, components and one verdict on the serial console", () => {
    expect(provision).toContain('step() { console "idots-build: $*"; }');
    expect(provision).toContain('component() { console "IDOTS-BUILD-COMPONENT: $1=$2"; }');
    expect(provision).toContain('console "IDOTS-BUILD-RESULT: ok"');
    expect(provision).toContain('console "IDOTS-BUILD-RESULT: failed at line $1: $2"');
  });

  it("builds the engine's Python environment with the script the seed carries, at the path the unit runs", () => {
    expect(provision).toContain('bash "$payload/$ENGINE_BUILD" "$payload/$ENGINE_LOCK" "$engine_venv" /opt/invisible-dots/engine');
    expect(provision).toContain("engine_venv=/opt/invisible-dots-engine\n");
    expect(provision).toContain('component engine-python "$engine_python"');
    // No build user and no Node build of the engine: its environment is the wheels of the lock.
    expect(provision).not.toMatch(/useradd --system|pnpm/i);
    expect(text(unitAsset("invisible-dots-agent.service"))).toContain(`ExecStart=/opt/invisible-dots-engine/bin/python `);
  });

  it("builds that environment from the hashed lock, wheels only, and joins the engine's source by a .pth file", () => {
    const build = text("builder/build-engine-env.sh");
    expect(build).toContain('uv venv --quiet --python /usr/bin/python3 "$venv"');
    expect(build).toContain('uv pip install --quiet --no-cache --python "$python" --require-hashes --only-binary :all: -r "$lock"');
    // The site-packages directory is asked of the venv's own Python, never written down.
    expect(build).toContain('sysconfig.get_path("purelib")');
    expect(build).toContain('printf \'%s\\n\' "$source_dir" > "$site_packages/invisible-dots-engine.pth"');
    // The copy of the lock the engine compares with the runtime disk's.
    expect(build).toContain('install -m 0644 "$lock" "$venv/requirements.lock"');
    expect(build).toContain('TIKTOKEN_CACHE_DIR="$venv/share/tiktoken"');
    expect(build).toContain('chown -R root:root "$venv"');
    expect(build).toContain('chmod -R go-w,a+rX "$venv"');
    // Never a resolution from the index, a build from source or a plain `pip install`.
    expect(build).not.toMatch(/pip install(?!.*--require-hashes)|--no-binary|--no-deps|-e /);
  });

  it("leaves no instance state behind", () => {
    expect(provision).toContain("cloud-init clean --logs --machine-id --seed");
    expect(provision).toContain("rm -f /etc/ssh/ssh_host_*");
  });
});
