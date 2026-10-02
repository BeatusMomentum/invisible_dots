import { describe, expect, it } from "vitest";
import {
  escapeXml,
  guestHostname,
  loadTemplates,
  renderDomainXml,
  renderSeed,
  renderTemplate,
  yamlScalar,
} from "../src/index.js";

const params = {
  dotId: "dot_01k6h3w2ze8m4qv7r1xk9bntc5",
  cid: 10007,
  cpus: 2,
  memoryMiB: 4096,
  diskPath: "/var/lib/invisible-dots/vms/dot_01k6h3w2ze8m4qv7r1xk9bntc5/disk.qcow2",
  seedPath: "/var/lib/invisible-dots/vms/dot_01k6h3w2ze8m4qv7r1xk9bntc5/seed.iso",
  runtimeImage: "/var/lib/invisible-dots/images/runtime-1.iso",
  serialLog: "/var/lib/invisible-dots/vms/dot_01k6h3w2ze8m4qv7r1xk9bntc5/serial.log",
};

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  it("escapes & first so entities are not double-escaped wrongly", () => {
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  it("refuses control characters XML cannot carry", () => {
    expect(() => escapeXml(`a${String.fromCharCode(1)}b`)).toThrow(/control character/);
    expect(escapeXml("tab\there")).toBe("tab\there");
  });
});

describe("renderTemplate", () => {
  it("fails on a placeholder without a value", () => {
    expect(() => renderTemplate("<a>{{missing}}</a>", {}, escapeXml)).toThrow(/"missing" has no value/);
  });

  it("encodes every value", () => {
    expect(renderTemplate("{{ a }}-{{b}}", { a: "<", b: 3 }, escapeXml)).toBe("&lt;-3");
  });
});

describe("domain XML", () => {
  it("renders the definition of section 3.4", async () => {
    const { domain } = await loadTemplates();
    const xml = renderDomainXml(domain, params);
    expect(xml).toContain("<domain type='kvm'>");
    expect(xml).toContain("<name>invisible-dot-dot_01k6h3w2ze8m4qv7r1xk9bntc5</name>");
    expect(xml).toContain("machine='q35'");
    expect(xml).toContain("<cpu mode='host-passthrough' check='none'/>");
    expect(xml).toContain("<vcpu placement='static'>2</vcpu>");
    expect(xml).toContain("<memory unit='MiB'>4096</memory>");
    expect(xml).toMatch(/<source file='[^']*disk\.qcow2'\/>\s*<target dev='vda' bus='virtio'\/>/);
    expect(xml).toMatch(/<source file='[^']*seed\.iso'\/>\s*<target dev='sda' bus='sata'\/>\s*<readonly\/>/);
    expect(xml).toMatch(/<source file='\/var\/lib\/invisible-dots\/images\/runtime-1\.iso'\/>\s*<target dev='sdb' bus='sata'\/>\s*<readonly\/>/);
    expect(xml).toContain("<source network='invisible-dots'/>");
    expect(xml).toContain("<cid auto='no' address='10007'/>");
    expect(xml).toContain("org.qemu.guest_agent.0");
    expect(xml).toContain(`<source path='${params.serialLog}' append='on'/>`);
    expect(xml).toContain("<rng model='virtio'>");
    expect(xml).not.toMatch(/\{\{|\}\}/);
  });

  it("escapes hostile paths so they cannot break out of an attribute", async () => {
    const { domain } = await loadTemplates();
    const xml = renderDomainXml(domain, { ...params, runtimeImage: "/images/a'/><evil/>&.iso" });
    expect(xml).toContain("<source file='/images/a&apos;/&gt;&lt;evil/&gt;&amp;.iso'/>");
    expect(xml).not.toContain("<evil/>");
  });

  it("has balanced elements", async () => {
    const { domain } = await loadTemplates();
    const xml = renderDomainXml(domain, params).replace(/<!--[\s\S]*?-->/g, "");
    const stack: string[] = [];
    for (const match of xml.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)[^>]*?(\/?)>/g)) {
      const [, closing, name, selfClosing] = match;
      if (selfClosing) continue;
      if (closing) expect(stack.pop()).toBe(name);
      else stack.push(name!);
    }
    expect(stack).toEqual([]);
  });
});

describe("cloud-init seed", () => {
  it("renders hostname, user, config file, runtime mount and the per-boot hook", async () => {
    const { seed } = await loadTemplates();
    const out = renderSeed(seed, "dot_abc", "tok\"en'&");
    expect(out.userData.startsWith("#cloud-config\n")).toBe(true);
    expect(out.userData).toContain('hostname: "invisible-dot-dot-abc"');
    expect(out.userData).toMatch(/- name: dot\n/);
    expect(out.userData).toContain("lock_passwd: true");
    expect(out.userData).toContain('sudo: "ALL=(ALL) NOPASSWD:ALL"');
    expect(out.userData).toContain("ssh_pwauth: false");
    expect(out.userData).toContain("path: /etc/invisible-dots/config.json");
    expect(out.userData).toContain('permissions: "0600"');
    expect(out.userData).toContain("owner: dot:dot");
    expect(out.userData).toContain('"LABEL=IDOTS-RT", /opt/invisible-dots, iso9660');
    expect(out.userData).toContain("exec /opt/invisible-dots/install.sh");

    const content = /content: (".*")\n/.exec(out.userData)?.[1];
    expect(content).toBeDefined();
    expect(JSON.parse(JSON.parse(content!))).toEqual({ dotId: "dot_abc", token: "tok\"en'&" });

    expect(out.metaData).toBe('instance-id: "iid-dot_abc"\nlocal-hostname: "invisible-dot-dot-abc"\n');
  });

  it("turns underscores into hyphens for the hostname", () => {
    expect(guestHostname("dot_01k6")).toBe("invisible-dot-dot-01k6");
  });

  it("encodes YAML scalars as quoted strings", () => {
    expect(yamlScalar("a: b\n# c")).toBe('"a: b\\n# c"');
  });
});
