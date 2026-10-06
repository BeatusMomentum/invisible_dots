/**
 * The golden image carries the GeoIP database of daijro/geoip-all-in-one, which merges the free editions of
 * several IP geolocation databases, each under its own data license, most asking to be credited.
 * THIRD_PARTY_NOTICES.md must carry the licenses and credit lines that guest/image-builder/src/geoip-notices.ts holds
 * (the same ones every golden manifest records), say which project the data comes from, and say that the image is
 * built by the person on their own machine, so invisible_dots does not redistribute the data. The licenses named are
 * the data sources', not the GPL-3.0 that GitHub shows on the merging project's repository, which is the license of
 * its scripts.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GEOIP_NOTICES, GEOIP_STATEMENT } from "../../guest/image-builder/src/geoip-notices.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const notices = readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8").replace(/\r\n/g, "\n");
const pins = JSON.parse(readFileSync(join(repo, "guest", "image-builder", "pins.json"), "utf8")) as { geoip: { url: string } };

/** Text with its line breaks and runs of spaces as single spaces, to compare a paragraph however it is wrapped. */
const squash = (text: string) => text.replace(/\s+/g, " ");

/** The data license of each source that the pinned release's README lists (daijro/geoip-all-in-one at 2026.09.30), by the start of its name. */
const SOURCE_LICENSES: Record<string, string> = {
  "IP2Location LITE": "CC BY-SA 4.0",
  "MaxMind GeoLite2": "GeoLite2 End User License Agreement",
  "DB-IP Lite": "CC BY 4.0",
  "IPinfo free country database": "CC BY-SA 4.0",
  "IPLocate.io free IP to Country database": "CC BY-SA 4.0",
  "GeoFeed + Whois + ASN country database of tdulcet/ip-geolocation-dbs": "CC0 1.0",
  "OpenStreetMap contributors": "ODbL 1.0",
};

/** The section of the notices that starts at `## GeoIP data`, up to the next second-level heading. */
function geoipSection(): string {
  const start = notices.indexOf("\n## GeoIP data in the golden image\n");
  expect(start, "THIRD_PARTY_NOTICES.md has a section for the GeoIP data").toBeGreaterThanOrEqual(0);
  const next = notices.indexOf("\n## ", start + 1);
  return notices.slice(start, next === -1 ? undefined : next);
}

describe("the notices of the GeoIP data in the golden image", () => {
  it("name the project the data is pinned from, and say what the image does with it", () => {
    const project = /github\.com\/([^/]+\/[^/]+)\//.exec(pins.geoip.url)![1]!;
    const section = geoipSection();
    expect(section).toContain(project);
    expect(section).toContain("pins.json");
    expect(section).toContain("`pinned.geoip`");
    expect(section).toContain("`notices`");
    expect(section).toContain("`notices_statement`");
  });

  it("carry the source, the license and the credit line of every source in the manifest's list, as written there", () => {
    expect(GEOIP_NOTICES.length).toBeGreaterThanOrEqual(7);
    const section = geoipSection();
    for (const notice of GEOIP_NOTICES) {
      expect(section, notice.source).toContain(notice.source);
      expect(section, notice.source).toContain(notice.license);
      expect(section, notice.source).toContain(notice.license_url);
      expect(section, notice.source).toContain(notice.attribution);
    }
  });

  it("name the data license of every source of the pinned release, and none of them is the GPL of the merging project's code", () => {
    expect(GEOIP_NOTICES).toHaveLength(Object.keys(SOURCE_LICENSES).length);
    for (const [source, license] of Object.entries(SOURCE_LICENSES)) {
      const notice = GEOIP_NOTICES.find((n) => n.source.startsWith(source));
      expect(notice, source).toBeDefined();
      expect(notice!.license, source).toBe(license);
    }
    for (const notice of GEOIP_NOTICES) {
      expect(notice.license, notice.source).not.toMatch(/GPL/);
      expect(notice.source, "the merging project is not a data source").not.toMatch(/^daijro\//);
    }
    expect(squash(geoipSection())).not.toMatch(/data[^.]*(is|are) (published|licensed|released) under the GPL/i);
  });

  it("say who builds the image and that this project does not redistribute the data, as the manifest's statement does", () => {
    expect(GEOIP_STATEMENT).toContain("on their own machine");
    expect(GEOIP_STATEMENT).toContain("invisible_dots does not publish or redistribute the image or the data");
    expect(GEOIP_STATEMENT).toContain("license of its scripts");
    expect(squash(geoipSection())).toContain(squash(GEOIP_STATEMENT));
  });

  it("say it again in the README, the image builder's README and the architecture document", () => {
    for (const path of ["README.md", "guest/image-builder/README.md", "docs/architecture.md"]) {
      const text = squash(readFileSync(join(repo, path), "utf8"));
      expect(text, path).toContain("does not redistribute");
    }
  });

  it("are listed among the exceptions to the repository's own license", () => {
    const head = notices.slice(0, notices.indexOf("\n## "));
    expect(head).toContain("GeoIP data");
  });
});
