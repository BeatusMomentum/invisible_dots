/**
 * Identifiers. Ids are lowercase so they are safe in QEMU `-name` values,
 * file paths and URLs, and they sort by creation time to the millisecond,
 * which keeps database indexes and directory listings in creation order.
 */

/** Crockford base32, lowercase: no i, l, o or u, so ids read back unambiguously. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const TIME_CHARS = 10; // 50 bits: milliseconds until the year 37000
const RANDOM_CHARS = 16; // 80 bits

function randomChars(count: number): string {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

function timeChars(ms: number): string {
  let out = "";
  let rest = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9]{0,15}$/;

/**
 * A new id such as `dot_01k6h3w2ze8m4qv7r1xk9bntc5`: the prefix, `_`, ten
 * characters of time and sixteen of randomness. Ids made in the same
 * millisecond do not sort among themselves.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(`invalid id prefix "${prefix}": expected 1 to 16 lowercase letters or digits, starting with a letter`);
  }
  return `${prefix}_${timeChars(now)}${randomChars(RANDOM_CHARS)}`;
}

/** The creation time encoded in an id made by `newId`, or null if it is not one. */
export function idTimestamp(id: string): number | null {
  const match = /^[a-z][a-z0-9]{0,15}_([0-9a-hjkmnp-tv-z]{26})$/.exec(id);
  if (!match) return null;
  let ms = 0;
  for (const char of match[1]!.slice(0, TIME_CHARS)) ms = ms * 32 + ALPHABET.indexOf(char);
  return ms;
}

const SLUG_MAX = 32;

/**
 * A lowercase slug of `[a-z0-9-]` for a human name: accents are dropped,
 * everything else becomes `-`. Never empty: a name with nothing usable gives
 * `fallback`.
 */
export function slugify(name: string, fallback = "identity"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** A browser identity id: the slug of its name plus a short random suffix (section 6). */
export function newIdentityId(name: string): string {
  return `${slugify(name)}-${randomChars(6)}`;
}

export const IDENTITY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a string is a safe identity id. Identity ids become directory names,
 * so anything that could walk out of the browsers directory is refused.
 */
export function isValidIdentityId(id: string): boolean {
  return id.length <= 64 && IDENTITY_ID_PATTERN.test(id);
}
