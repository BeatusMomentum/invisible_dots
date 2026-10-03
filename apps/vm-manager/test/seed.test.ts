import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { permissionBitsEnforced } from "@invisible-dots/shared";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  guestHostname,
  loadSeedTemplates,
  renderSeed,
  renderTemplate,
  RUNTIME_ISO_LABEL,
  writeSeedIso,
  yamlScalar,
} from "../src/index.js";

const DOT = "dot_01k6h3w2ze8m4qv7r1xk9bntc5";

describe("templates", () => {
  it("fills placeholders and refuses a missing value", () => {
    expect(renderTemplate("a {{ x }} b {{y}}", { x: 1, y: "z" }, (v) => `<${v}>`)).toBe("a <1> b <z>");
    expect(() => renderTemplate("{{missing}}", {}, String)).toThrow(/missing/);
  });

  it("quotes YAML scalars so a token cannot break out", () => {
    const tricky = 'a"b\nc: d #e';
    expect(parse(`k: ${yamlScalar(tricky)}`)).toEqual({ k: tricky });
  });

  it("turns dot ids into hostnames", () => {
    expect(guestHostname(DOT)).toBe("invisible-dot-dot-01k6h3w2ze8m4qv7r1xk9bntc5");
  });
});

describe("the seed of a Dot", () => {
  it("renders cloud-config that writes config.json and mounts the runtime ISO by label", async () => {
    const seed = renderSeed(await loadSeedTemplates(), DOT, "tok\"en");
    expect(seed.userData.startsWith("#cloud-config\n")).toBe(true);
    const userData = parse(seed.userData);
    const config = userData.write_files.find((file: { path: string }) => file.path === "/etc/invisible-dots/config.json");
    expect(JSON.parse(config.content)).toEqual({ dotId: DOT, token: 'tok"en' });
    expect(config.permissions).toBe("0600");
    expect(config.owner).toBe("dot:dot");
    expect(userData.mounts[0][0]).toBe(`LABEL=${RUNTIME_ISO_LABEL}`);
    expect(userData.mounts[0][1]).toBe("/opt/invisible-dots");
    expect(userData.hostname).toBe(guestHostname(DOT));
    expect(parse(seed.metaData)).toEqual({ "instance-id": seed.instanceId, "local-hostname": guestHostname(DOT) });
  });

  it("lets dot run exactly the poweroff dot-agentd starts as root, and nothing else (section 4.1)", async () => {
    const userData = parse(renderSeed(await loadSeedTemplates(), DOT, "token").userData);
    const dot = userData.users.find((user: { name: string }) => user.name === "dot");
    expect(dot.sudo).toBe("ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff");
    expect(dot.groups).toEqual(["audio", "video", "systemd-journal"]);
    // cloud-init applies groups only where it creates the user, the golden image's builder seed: the two must agree.
    const builder = parse(await readFile(fileURLToPath(new URL("../../../guest/image-builder/builder/user-data.yaml", import.meta.url)), "utf8"));
    expect(builder.users.find((user: { name: string }) => user.name === "dot").groups).toEqual(dot.groups);
    // The argv dot-agentd runs (guest/dot-agentd server.go DefaultPowerOff) is the command the rule names.
    const server = await readFile(fileURLToPath(new URL("../../../guest/dot-agentd/internal/agentd/server.go", import.meta.url)), "utf8");
    expect(server).toContain('var DefaultPowerOff = []string{"sudo", "-n", "systemctl", "poweroff"}');
  });

  it("changes the instance-id exactly when the seed content changes", async () => {
    const templates = await loadSeedTemplates();
    const a = renderSeed(templates, DOT, "token-a");
    expect(renderSeed(templates, DOT, "token-a").instanceId).toBe(a.instanceId);
    expect(renderSeed(templates, DOT, "token-b").instanceId).not.toBe(a.instanceId);
    expect(renderSeed({ ...templates, userData: `${templates.userData}\n# new\n` }, DOT, "token-a").instanceId).not.toBe(a.instanceId);
    expect(a.instanceId.startsWith(`iid-${DOT}-`)).toBe(true);
  });

  it("templates have LF endings and only ASCII, as files the guest reads", async () => {
    for (const name of ["user-data.yaml.tmpl", "meta-data.yaml.tmpl"]) {
      const text = await readFile(join(new URL("../../../virtualization/cloud-init/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), name), "utf8");
      expect(text).not.toContain("\r");
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(text)).toBe(true);
    }
  });
});

describe("writeSeedIso", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "idots-seed-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the same bytes for the same seed, labelled cidata, private to the user", async () => {
    const seed = renderSeed(await loadSeedTemplates(), DOT, "token");
    const first = join(dir, "a.iso");
    const second = join(dir, "b.iso");
    await writeSeedIso(first, seed);
    await writeSeedIso(second, seed);
    const bytes = await readFile(first);
    expect(bytes.equals(await readFile(second))).toBe(true);
    expect(bytes.subarray(16 * 2048 + 40, 16 * 2048 + 46).toString("latin1")).toBe("cidata");
    expect(bytes.includes(Buffer.from(seed.instanceId))).toBe(true);
    if (permissionBitsEnforced()) expect((await stat(first)).mode & 0o777).toBe(0o600);
  });
});
