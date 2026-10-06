/**
 * The golden image carries the GeoIP database of daijro/geoip-all-in-one, which merges the free editions of
 * several IP geolocation databases, and those ask to be credited. THIRD_PARTY_NOTICES.md must carry the credit
 * lines that guest/image-builder/src/geoip-notices.ts holds (the same ones every golden manifest records), and
 * must say which project the data comes from.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GEOIP_NOTICES } from "../../guest/image-builder/src/geoip-notices.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const notices = readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8").replace(/\r\n/g, "\n");
const pins = JSON.parse(readFileSync(join(repo, "guest", "image-builder", "pins.json"), "utf8")) as { geoip: { url: string } };

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

  it("are listed among the exceptions to the repository's own license", () => {
    const head = notices.slice(0, notices.indexOf("\n## "));
    expect(head).toContain("GeoIP data");
  });
});
