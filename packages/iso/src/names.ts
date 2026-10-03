/**
 * Names in the two directory trees of the image.
 *
 * The Joliet tree carries the real names and is the one Linux and Windows
 * show when they mount the image. The primary ISO 9660 tree exists because
 * the standard requires it and some readers only look there; it gets
 * level 1 "8.3" names derived from the real ones, made unique per directory.
 */
import { IsoError } from "./encoding.js";

/**
 * Joliet allows 64 UCS-2 characters per name. Linux and libisofs read up to
 * 103, but staying inside the specification keeps the image readable by
 * every tool that checks it.
 */
export const MAX_JOLIET_NAME_LENGTH = 64;

/**
 * ISO 9660 limits the directory hierarchy to 8 levels, the root being the
 * first, so a file path has at most 8 components.
 */
export const MAX_PATH_COMPONENTS = 8;

/** Characters Joliet forbids in a name (Joliet specification 3.3), plus control characters. */
const JOLIET_FORBIDDEN = /[\u0000-\u001f*/:;?\\]/;

/**
 * The volume identifier is written byte for byte into the primary descriptor
 * and as UCS-2 into the Joliet one, whose field holds 16 characters. Keeping
 * it within 16 characters makes the two identical, which is what `blkid`
 * (and therefore mount by label and cloud-init's NoCloud detection) reads.
 * Strict ISO 9660 wants only A-Z, 0-9 and "_" there; lowercase and "-" are
 * accepted because cloud-init looks for "cidata" and genisoimage writes it
 * the same way.
 */
const VOLUME_ID = /^[A-Za-z0-9_-]{1,16}$/;

export function validateVolumeId(volumeId: string): void {
  if (!VOLUME_ID.test(volumeId)) {
    throw new IsoError(`invalid volume identifier "${volumeId}": expected 1 to 16 characters from A-Z, a-z, 0-9, "_" and "-"`);
  }
}

/** Splits an image path ("dir/sub/name", a leading "/" is allowed) into validated names. */
export function splitImagePath(path: string): string[] {
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length === 1 && parts[0] === "") throw new IsoError(`empty path "${path}"`);
  for (const part of parts) validateName(part, path);
  if (parts.length > MAX_PATH_COMPONENTS) {
    throw new IsoError(`"${path}" is ${parts.length} levels deep; ISO 9660 allows at most ${MAX_PATH_COMPONENTS}`);
  }
  return parts;
}

function validateName(name: string, path: string): void {
  if (name === "") throw new IsoError(`"${path}" has an empty path component`);
  if (name === "." || name === "..") throw new IsoError(`"${path}" contains "${name}"`);
  if (JOLIET_FORBIDDEN.test(name)) {
    throw new IsoError(`"${path}": the name "${name}" contains a character Joliet does not allow (control characters, * / : ; ? \\)`);
  }
  if (name.length > MAX_JOLIET_NAME_LENGTH) {
    throw new IsoError(`"${path}": the name "${name}" is ${name.length} characters; Joliet allows ${MAX_JOLIET_NAME_LENGTH}`);
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    // Joliet is UCS-2: a character outside the Basic Multilingual Plane would
    // need a surrogate pair, which UCS-2 readers show as two broken characters.
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new IsoError(`"${path}": the name "${name}" contains a character outside the Basic Multilingual Plane, which Joliet cannot store`);
    }
  }
}

function toDCharacters(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/**
 * Hands out level 1 identifiers for one directory: "NAME.EXT;1" for files,
 * "NAME" for directories. Call it with the children in a fixed order, so the
 * same input always gives the same names.
 */
export class PrimaryNamer {
  private readonly used = new Set<string>();

  file(name: string): string {
    const dot = name.lastIndexOf(".");
    const rawBase = dot > 0 ? name.slice(0, dot) : name;
    const rawExt = dot > 0 ? name.slice(dot + 1) : "";
    const base = toDCharacters(rawBase).slice(0, 8) || "_";
    const ext = toDCharacters(rawExt).slice(0, 3);
    const unique = this.claim(base, (candidate) => `${candidate}.${ext}`);
    return `${unique};1`;
  }

  directory(name: string): string {
    const base = toDCharacters(name).slice(0, 8) || "_";
    return this.claim(base, (candidate) => candidate);
  }

  private claim(base: string, identifier: (base: string) => string): string {
    let id = identifier(base);
    for (let n = 1; this.used.has(id); n++) {
      const suffix = String(n);
      id = identifier(base.slice(0, 8 - suffix.length) + suffix);
    }
    this.used.add(id);
    return id;
  }
}

/**
 * ECMA-119 9.3: records are ordered by name, then extension, each compared
 * as if padded with spaces. Every d-character sorts above the space, so this
 * is a plain comparison of the two parts in turn.
 */
export function comparePrimaryIds(a: string, b: string): number {
  const [aName, aExt] = splitPrimaryId(a);
  const [bName, bExt] = splitPrimaryId(b);
  if (aName !== bName) return aName < bName ? -1 : 1;
  if (aExt !== bExt) return aExt < bExt ? -1 : 1;
  return 0;
}

function splitPrimaryId(id: string): [string, string] {
  const bare = id.replace(/;1$/, "");
  const dot = bare.indexOf(".");
  return dot === -1 ? [bare, ""] : [bare.slice(0, dot), bare.slice(dot + 1)];
}

/** Joliet records are ordered by their UCS-2 code units, which is how JavaScript compares strings. */
export function compareJolietNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
