// Fails while the GeoIP release pinned in guest/image-builder/pins.json is still downloadable but no longer the
// newest one, so the pin is refreshed before upstream deletes it and the required browser-smoke job (and every
// `image build` without a cached archive) starts to answer 404.
//
//   node .github/scripts/geoip-pin.mjs [--pins <file>] [--releases <file>]
//
// daijro/geoip-all-in-one is rebuilt weekly and keeps only its latest two releases. The pin is therefore good for
// about two weeks after the release it names is published; this check goes red as soon as a newer release exists,
// which leaves about a week to bump it. It also fails when the pinned release is gone, or when the digest GitHub
// shows for the pinned asset is not the pinned SHA-256 (a re-uploaded asset).
//
// --pins      default guest/image-builder/pins.json (the "geoip" entry).
// --releases  a saved copy of the releases API answer, for the tests; by default the live one, with GITHUB_TOKEN when set.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ASSET = "geoip-aio-all.mmdb.zip";
const API = "https://api.github.com/repos/daijro/geoip-all-in-one/releases?per_page=10";

/** Judges one pin against the releases the API listed. Returns { ok, message }. */
export function judgeGeoipPin(pin, releases) {
  const withAsset = releases
    .filter((release) => !release.draft && !release.prerelease && release.assets?.some((asset) => asset.name === ASSET))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  if (withAsset.length === 0) return { ok: false, message: `no release of daijro/geoip-all-in-one carries ${ASSET}` };
  const latest = withAsset[0];
  const fresh = `put tag ${latest.tag_name}, URL https://github.com/daijro/geoip-all-in-one/releases/download/${latest.tag_name}/${ASSET} and the sha256 ${digestOf(latest) ?? "(see the asset's digest)"} into the "geoip" entry of guest/image-builder/pins.json`;
  const index = withAsset.findIndex((release) => release.tag_name === pin.tag);
  if (index < 0) return { ok: false, message: `the pinned GeoIP release ${pin.tag} is gone from upstream: every build without a cached archive fails with HTTP 404. Fix it now: ${fresh}` };
  const digest = digestOf(withAsset[index]);
  if (digest !== undefined && digest !== pin.sha256) {
    return { ok: false, message: `the pinned GeoIP release ${pin.tag} now has digest ${digest}, not the pinned ${pin.sha256}: the asset was re-uploaded. Fix it: ${fresh}` };
  }
  if (index > 0) {
    return { ok: false, message: `the pinned GeoIP release ${pin.tag} is ${index} release(s) behind ${latest.tag_name}; upstream keeps only its latest two, so it is deleted when the next one is published. Bump it before then: ${fresh}` };
  }
  return { ok: true, message: `the pinned GeoIP release ${pin.tag} is the newest one` };
}

function digestOf(release) {
  const digest = release.assets.find((asset) => asset.name === ASSET)?.digest;
  return typeof digest === "string" && digest.startsWith("sha256:") ? digest.slice("sha256:".length) : undefined;
}

async function main(argv) {
  const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i < 0 ? fallback : argv[i + 1];
  };
  const pins = JSON.parse(readFileSync(option("--pins", new URL("../../guest/image-builder/pins.json", import.meta.url)), "utf8"));
  let releases;
  const saved = option("--releases", undefined);
  if (saved) releases = JSON.parse(readFileSync(saved, "utf8"));
  else {
    const headers = { accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(API, { headers });
    if (!response.ok) throw new Error(`${API} answered HTTP ${response.status}`);
    releases = await response.json();
  }
  const { ok, message } = judgeGeoipPin(pins.geoip, releases);
  (ok ? console.log : console.error)(message);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
