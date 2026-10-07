/** What a lock file says about the license of each package it installs. Shared by the checks that read package-lock.json files. */

export interface LockedPackage {
  /** The lock's key, such as `node_modules/baileys`. */
  path: string;
  version?: string;
  license?: string;
  link?: boolean;
  resolved?: string;
  integrity?: string;
}

/** Every package of an npm lock file (lockfileVersion 3), the root project left out. */
export function lockedPackages(lock: { packages: Record<string, Omit<LockedPackage, "path">> }): LockedPackage[] {
  return Object.entries(lock.packages)
    .filter(([path]) => path !== "")
    .map(([path, entry]) => ({ path, ...entry }));
}

/** The name a package is installed under: `node_modules/a/node_modules/b` is `b`. */
export function packageName(path: string): string {
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

/** Whether one license identifier is GPL or AGPL (any version); LGPL is a different license and is not matched. */
const isStrongCopyleft = (id: string) => /^A?GPL-/i.test(id.trim());

/**
 * Whether installing under this SPDX expression would put GPL or AGPL code on the machine: true for `GPL-3.0` and
 * `MIT AND GPL-2.0-only`; false for `(MIT OR GPL-3.0)`, which can be taken as MIT, and for `LGPL-3.0-or-later`.
 */
export function needsStrongCopyleft(expression: string): boolean {
  const alternatives = expression
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/)
    .map((alternative) => alternative.split(/\s+AND\s+/));
  return alternatives.every((conjunction) => conjunction.some((id) => isStrongCopyleft(id.replace(/\s+WITH\s+.*$/, ""))));
}

/** Whether the expression names LGPL anywhere. */
export const mentionsLgpl = (expression: string): boolean => /\bLGPL-/i.test(expression);
