/**
 * The pinned inputs of the golden image: the Ubuntu cloud image
 * (virtualization/images/base.json) and the third-party software installed
 * into it (pins.json). Both are imported as JSON modules so a bundled CLI
 * carries them inside the bundle instead of looking for them on disk.
 */
import baseJson from "../../../virtualization/images/base.json" with { type: "json" };
import pinsJson from "../pins.json" with { type: "json" };

/** A file fetched from the network: the pinned SHA-256 decides, the published checksum list must agree. */
export interface PinnedDownload {
  version: string;
  url: string;
  /** The checksum list the project publishes next to the file. */
  shasums_url: string;
  /** The file's name in that list. */
  shasums_entry: string;
  sha256: string;
}

/**
 * The GeoIP database a launch with the timezone left to "auto" needs: one release of daijro/geoip-all-in-one, by its
 * exact URL and the SHA-256 of that file. The project publishes no checksum list, so the pin is the only record: it
 * is the `digest` GitHub shows for the release asset (api.github.com/repos/daijro/geoip-all-in-one/releases/latest).
 * Upstream keeps only its latest releases, so a pin that is not refreshed answers 404 within weeks (see the README).
 */
export interface GeoipPin {
  /** The release tag, a date; it names the directory the database is cached in. */
  tag: string;
  url: string;
  sha256: string;
}

export interface BaseImagePin {
  name: string;
  release: string;
  serial: string;
  url: string;
  sha256sums_url: string;
  sha256sums_entry: string;
  sha256: string;
  /** File name under the images directory (architecture section 3.2). */
  local_name: string;
}

/**
 * The Python packages are not here: builder/mcp-requirements.lock pins them
 * with their hashes, and is the one place their versions live (python-lock.ts).
 */
export interface GuestPins {
  node: PinnedDownload;
  uv: PinnedDownload;
  geoip: GeoipPin;
  apt_packages: string[];
}

const SHA256 = /^[0-9a-f]{64}$/;
/**
 * Versions and package names end up in a shell file inside the builder VM
 * (pins.env), so they are restricted to characters that need no quoting
 * rather than escaped.
 */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function field(object: Record<string, unknown>, key: string, where: string): string {
  const value = object[key];
  if (typeof value !== "string" || value === "") throw new Error(`${where}: "${key}" must be a non-empty string`);
  return value;
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function https(url: string, where: string): string {
  if (!url.startsWith("https://")) throw new Error(`${where}: ${url} is not an https URL`);
  return url;
}

function sha256(value: string, where: string): string {
  if (!SHA256.test(value)) throw new Error(`${where}: "${value}" is not a lowercase hex SHA-256`);
  return value;
}

function plainWord(value: string, where: string): string {
  if (!PLAIN_WORD.test(value)) throw new Error(`${where}: "${value}" may only hold letters, digits, ".", "+", "_" and "-"`);
  return value;
}

function parseDownload(value: unknown, where: string): PinnedDownload {
  const o = asObject(value, where);
  const pin: PinnedDownload = {
    version: plainWord(field(o, "version", where), `${where}.version`),
    url: https(field(o, "url", where), `${where}.url`),
    shasums_url: https(field(o, "shasums_url", where), `${where}.shasums_url`),
    shasums_entry: field(o, "shasums_entry", where),
    sha256: sha256(field(o, "sha256", where), `${where}.sha256`),
  };
  // The guest provisioner finds the tarball by its file name, which is the last URL segment.
  if (!FILE_NAME.test(downloadFileName(pin))) throw new Error(`${where}.url must end in a plain file name`);
  return pin;
}

/** The release asset that holds the database, and where a release of the project lives. */
const GEOIP_ASSET = "geoip-aio-all.mmdb.zip";
const GEOIP_RELEASES = "https://github.com/daijro/geoip-all-in-one/releases/download";

function parseGeoip(value: unknown, where: string): GeoipPin {
  const o = asObject(value, where);
  const tag = plainWord(field(o, "tag", where), `${where}.tag`);
  const url = https(field(o, "url", where), `${where}.url`);
  const expected = `${GEOIP_RELEASES}/${tag}/${GEOIP_ASSET}`;
  if (url !== expected) throw new Error(`${where}.url must be ${expected}`);
  return { tag, url, sha256: sha256(field(o, "sha256", where), `${where}.sha256`) };
}

/** The name a pinned download is stored under in the cache and on the builder seed. */
export function downloadFileName(pin: { url: string }): string {
  return new URL(pin.url).pathname.split("/").pop() ?? "";
}

/**
 * The name the GeoIP archive is cached under: its tag first, because every release has the same file name upstream
 * and a pin bump would otherwise delete the only verified copy of the release the previous pin names, which the
 * project has deleted by then. (The seed keeps `downloadFileName`: the guest finds the archive by it.)
 */
export function geoipCacheName(pin: GeoipPin): string {
  return `geoip-${pin.tag}-${downloadFileName(pin)}`;
}

export function parseBaseImagePin(value: unknown): BaseImagePin {
  const where = "virtualization/images/base.json";
  const o = asObject(value, where);
  const pin: BaseImagePin = {
    name: field(o, "name", where),
    release: field(o, "release", where),
    serial: plainWord(field(o, "serial", where), `${where} serial`),
    url: https(field(o, "url", where), `${where} url`),
    sha256sums_url: https(field(o, "sha256sums_url", where), `${where} sha256sums_url`),
    sha256sums_entry: field(o, "sha256sums_entry", where),
    sha256: sha256(field(o, "sha256", where), `${where} sha256`),
    local_name: field(o, "local_name", where),
  };
  if (!FILE_NAME.test(pin.local_name)) throw new Error(`${where}: local_name "${pin.local_name}" must be a plain file name`);
  return pin;
}

export function parseGuestPins(value: unknown): GuestPins {
  const where = "guest/image-builder/pins.json";
  const o = asObject(value, where);
  if ("python_packages" in o) throw new Error(`${where}: python_packages moved to builder/mcp-requirements.lock, which pins them with their hashes`);
  const apt = o.apt_packages;
  if (!Array.isArray(apt) || apt.length === 0) throw new Error(`${where}: apt_packages must be a non-empty array`);
  return {
    node: parseDownload(o.node, `${where} node`),
    uv: parseDownload(o.uv, `${where} uv`),
    geoip: parseGeoip(o.geoip, `${where} geoip`),
    apt_packages: apt.map((name, i) => plainWord(typeof name === "string" ? name : "", `${where} apt_packages[${i}]`)),
  };
}

/** The pins in this checkout, validated once at import so a bad edit fails every command that uses them. */
export const BASE_IMAGE: BaseImagePin = parseBaseImagePin(baseJson);
export const GUEST_PINS: GuestPins = parseGuestPins(pinsJson);
