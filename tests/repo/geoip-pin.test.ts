/**
 * The GeoIP release pinned in guest/image-builder/pins.json is deleted by its project about two weeks after it is
 * published, and the required browser-smoke job and every image build without a cached archive download it.
 * .github/scripts/geoip-pin.mjs (run daily by .github/workflows/geoip-pin.yml) is the warning: it must go red
 * while the pin still downloads, when it is gone, and when its asset was replaced.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const script = join(repo, ".github", "scripts", "geoip-pin.mjs");
const pins = JSON.parse(readFileSync(join(repo, "guest", "image-builder", "pins.json"), "utf8")) as { geoip: { tag: string; sha256: string } };
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const release = (tag: string, published: string, sha256: string | undefined, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  published_at: published,
  draft: false,
  prerelease: false,
  assets: [{ name: "geoip-aio-all.mmdb.zip", ...(sha256 ? { digest: `sha256:${sha256}` } : {}) }, { name: "geoip-aio-city.mmdb.zip", digest: `sha256:${"0".repeat(64)}` }],
  ...extra,
});

function run(releases: unknown[]): { code: number | null; out: string } {
  dir = mkdtempSync(join(tmpdir(), "idots-geoip-"));
  const file = join(dir, "releases.json");
  writeFileSync(file, JSON.stringify(releases));
  const result = spawnSync(process.execPath, [script, "--releases", file], { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const NEWER = "2099.01.07";
const pinned = () => release(pins.geoip.tag, "2026-09-30T00:00:00Z", pins.geoip.sha256);

describe("the pinned GeoIP release check", () => {
  it("passes while the pin is the newest release", () => {
    const { code, out } = run([pinned(), release("2026.09.23", "2026-09-23T00:00:00Z", "1".repeat(64))]);
    expect(out).toContain("is the newest one");
    expect(code).toBe(0);
  });

  it("goes red as soon as a newer release exists, while the pin still downloads, and names what to pin", () => {
    const newer = "2".repeat(64);
    const { code, out } = run([release(NEWER, "2099-01-07T00:00:00Z", newer), pinned()]);
    expect(code).toBe(1);
    expect(out).toContain(`${pins.geoip.tag} is 1 release(s) behind ${NEWER}`);
    expect(out).toContain(`releases/download/${NEWER}/geoip-aio-all.mmdb.zip`);
    expect(out).toContain(newer);
  });

  it("goes red when the pinned release is gone", () => {
    const { code, out } = run([release(NEWER, "2099-01-07T00:00:00Z", "2".repeat(64)), release("2098.12.31", "2098-12-31T00:00:00Z", "3".repeat(64))]);
    expect(code).toBe(1);
    expect(out).toContain(`${pins.geoip.tag} is gone from upstream`);
  });

  it("goes red when the pinned asset was re-uploaded under the same tag", () => {
    const { code, out } = run([release(pins.geoip.tag, "2026-09-30T00:00:00Z", "4".repeat(64))]);
    expect(code).toBe(1);
    expect(out).toContain("was re-uploaded");
  });

  it("ignores drafts and prereleases, and fails when no release carries the database", () => {
    expect(run([release(NEWER, "2099-01-07T00:00:00Z", "2".repeat(64), { prerelease: true }), pinned()]).code).toBe(0);
    expect(run([release(NEWER, "2099-01-07T00:00:00Z", "2".repeat(64), { draft: true }), pinned()]).code).toBe(0);
    const empty = run([{ tag_name: NEWER, published_at: "2099-01-07T00:00:00Z", draft: false, prerelease: false, assets: [] }]);
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("no release of daijro/geoip-all-in-one carries");
  });

  it("runs daily from its own workflow, which `gate` does not wait for", () => {
    const workflow = readFileSync(join(repo, ".github", "workflows", "geoip-pin.yml"), "utf8");
    expect(workflow).toMatch(/schedule:\s+- cron: "\d+ \d+ \* \* \*"/);
    expect(workflow).toContain("node .github/scripts/geoip-pin.mjs");
    expect(readFileSync(join(repo, ".github", "workflows", "tests.yml"), "utf8")).not.toContain("geoip-pin");
    expect(readFileSync(join(repo, "guest", "image-builder", "README.md"), "utf8")).toContain(".github/workflows/geoip-pin.yml");
  });
});
