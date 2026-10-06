/**
 * The Windows PowerShell the host runs to read what only Windows can say
 * (architecture section 1.1): the state of the HypervisorPlatform feature,
 * and the one program that runs it. Scripts travel as -EncodedCommand
 * (base64 of UTF-16LE), never as a file: nothing on disk can be swapped
 * between generating a script and running it, and no argument needs quoting
 * rules beyond PowerShell's own. `invisible-dots setup` builds its elevated
 * scripts on the same two functions.
 */

/** The Windows optional feature WHPX needs. */
export const HYPERVISOR_PLATFORM_FEATURE = "HypervisorPlatform";

/**
 * Read without administrator rights, unlike Get-WindowsOptionalFeature.
 * InstallState: 1 enabled, 2 disabled, 3 absent; no output when Windows does
 * not list the feature at all.
 */
export const HYPERVISOR_PLATFORM_STATE_SCRIPT = `(Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='${HYPERVISOR_PLATFORM_FEATURE}'").InstallState`;

export function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Windows PowerShell 5.1 by absolute path: it ships with every Windows, and PATH could point anywhere. */
export function powershellPath(env: Record<string, string | undefined>): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(script)];
}
