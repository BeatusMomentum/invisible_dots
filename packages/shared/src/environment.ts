/**
 * The environment a child process gets: an allowlist of the parent's
 * variables, never a copy with things removed. The control plane's
 * environment can hold INVISIBLE_DOTS_TOKEN and a DATABASE_URL with its
 * password, the agent's the OpenRouter key; a child that needs none of them
 * must not carry them for its whole life (a Dot's QEMU outlives the server
 * that started it). One filter, used for QEMU on the host and for the
 * browser layer in the guest.
 */

/** What any program needs from its environment to start and find its files, on Linux and on Windows. */
export const BASE_CHILD_ENV_VARS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  // Windows cannot start a process without the first ones; the others are where programs find their files.
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMFILES",
];

/**
 * The variables of `base` named in `allowed`. Names compare without case,
 * because Windows environment names are case-insensitive (`Path` is `PATH`)
 * and Linux ones never differ only by case here. A value starting with "()"
 * is an exported shell function, a known injection vector, and is dropped.
 */
export function allowlistedEnvironment(
  base: Record<string, string | undefined>,
  allowed: readonly string[] = BASE_CHILD_ENV_VARS,
): Record<string, string> {
  const names = new Set(allowed.map((name) => name.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || !names.has(name.toUpperCase())) continue;
    if (value.startsWith("()")) continue;
    env[name] = value;
  }
  return env;
}
