/**
 * The QEMU version `setup` installs on Windows, pinned in
 * virtualization/qemu/windows.json (architecture sections 2 and 11.2): the
 * official installer's URL, its SHA-256 and the arguments that run it
 * silently. The project never redistributes QEMU; the pin only says which
 * official bytes are acceptable and how to run them. Fields this file does
 * not read (size, SHA-512, the provenance notes) are for the person who
 * updates the pin.
 */

export interface WindowsQemuPin {
  version: string;
  url: string;
  sha256: string;
  /** Passed to the installer in the elevated session, e.g. ["/S"] for NSIS. */
  silentArgs: string[];
}

export const WINDOWS_QEMU_PIN_FILE = "virtualization/qemu/windows.json";

/** Validates the pin file, so a typo stops setup before anything is downloaded or elevated. */
export function parseWindowsQemuPin(value: unknown, origin = WINDOWS_QEMU_PIN_FILE): WindowsQemuPin {
  if (typeof value !== "object" || value === null) throw new Error(`${origin}: expected a JSON object`);
  const record = value as Record<string, unknown>;
  const text = (key: string): string => {
    const v = record[key];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`${origin}: "${key}" must be a non-empty string`);
    return v.trim();
  };
  const version = text("version");
  const url = text("url");
  const sha256 = text("sha256").toLowerCase();
  if (!/^\d+\.\d+/.test(version)) throw new Error(`${origin}: "version" must start with major.minor, got "${version}"`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${origin}: "url" is not a URL: "${url}"`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${origin}: "url" must use https, got "${url}"`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${origin}: "sha256" must be 64 hexadecimal characters`);
  const silent = record.silent_args;
  // Without its silent switch the installer opens a wizard in the elevated session and setup waits on it forever.
  if (!Array.isArray(silent) || silent.length === 0 || !silent.every((a) => typeof a === "string" && a.trim() !== "")) {
    throw new Error(`${origin}: "silent_args" must be a non-empty list of strings, e.g. ["/S"]`);
  }
  return { version, url, sha256, silentArgs: silent.map((a: string) => a.trim()) };
}

/**
 * The file name the installer is saved under: the URL's own name when it is
 * a plain .exe name, else a fixed one. It ends up inside a PowerShell string
 * and a Windows path, so nothing but letters, digits, ".", "_" and "-" is kept.
 */
export function installerFileName(pin: WindowsQemuPin): string {
  let last = "";
  try {
    last = decodeURIComponent(new URL(pin.url).pathname.split("/").pop() ?? "");
  } catch {
    // A malformed escape in the URL: fall back to the fixed name below.
  }
  return /^[A-Za-z0-9._-]+\.exe$/i.test(last) ? last : `qemu-${pin.version.replace(/[^A-Za-z0-9.-]/g, "")}-setup.exe`;
}
