/**
 * The PowerShell that `invisible-dots setup` runs on Windows (architecture
 * section 11.2). Pure text generation, so the tests pin every line that will
 * run with administrator rights.
 *
 * Scripts travel as -EncodedCommand (base64 of UTF-16LE), never as a file:
 * nothing on disk can be swapped between generating the elevated script and
 * the UAC prompt, and no argument needs quoting rules beyond PowerShell's own.
 */

/** dism's "succeeded, restart required". */
export const RESTART_REQUIRED_EXIT_CODE = 3010;

/** The Windows optional feature WHPX needs. */
export const HYPERVISOR_PLATFORM_FEATURE = "HypervisorPlatform";

/**
 * Read without administrator rights, unlike Get-WindowsOptionalFeature.
 * InstallState: 1 enabled, 2 disabled, 3 absent; no output when Windows does
 * not list the feature at all.
 */
export const HYPERVISOR_PLATFORM_STATE_SCRIPT = `(Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='${HYPERVISOR_PLATFORM_FEATURE}'").InstallState`;

/**
 * A PowerShell single-quoted string literal. PowerShell also treats the
 * typographic quotes U+2018 to U+201B as single quotes, so they are doubled too.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

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

export interface ElevatedScriptOptions {
  enableHypervisorPlatform: boolean;
  /** The downloaded and verified QEMU installer; omitted when QEMU is already installed. */
  installer?: { path: string; sha256: string; silentArgs: readonly string[] };
  /**
   * A directory that does not exist yet, directly under the system's
   * ProgramData. The elevated session creates it for administrators and
   * SYSTEM alone (the person running setup may read it) and keeps in it
   * everything it runs or writes: the installer's copy and the result.
   */
  workDir: string;
  /** The security identifier of the person running setup, who reads the result and then removes `workDir`. */
  userSid: string;
}

/** The file in `workDir` the elevated session writes what happened to, as JSON. */
export const ELEVATED_RESULT_FILE = "result.json";

/** The elevated session's exit code when it could not create its private directory, so nothing ran. */
export const UNSAFE_WORK_DIR_EXIT_CODE = 2;

/**
 * The elevated session. It records each exit code in a JSON file the
 * non-elevated setup reads back, because the exit code of an elevated
 * process is all Start-Process hands back and it cannot carry both steps.
 *
 * Nothing it runs or writes is in a place the normal user can change: a
 * program running as that user could swap an installer between its hash
 * check and its start, plant a DLL next to it, or turn the result file into
 * a link to anywhere. So the installer is copied into a new directory under
 * ProgramData that only administrators and SYSTEM can write, created with
 * that ACL in one step and checked to be empty; the COPY is hashed and run,
 * from that directory; the result is written there. dism is found through
 * the system directory Windows reports, never an environment variable the
 * user can set.
 */
export function elevatedSetupScript(options: ElevatedScriptOptions): string {
  const unsafe = UNSAFE_WORK_DIR_EXIT_CODE;
  const lines = [
    "# invisible-dots setup: the one step that needs administrator rights (architecture section 11.2).",
    "$ErrorActionPreference = 'Stop'",
    "$result = [ordered]@{ dism_exit_code = $null; installer_exit_code = $null; install_dir = $null; error = $null }",
    `$work = ${psQuote(options.workDir)}`,
    `$user = New-Object System.Security.Principal.SecurityIdentifier ${psQuote(options.userSid)}`,
    "function New-Rule($sid, $rights) { New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow') }",
    `if ((Split-Path -Parent $work) -ne [Environment]::GetFolderPath('CommonApplicationData')) { exit ${unsafe} }`,
    "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$acl.AddAccessRule((New-Rule (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544') 'FullControl'))",
    "$acl.AddAccessRule((New-Rule (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18') 'FullControl'))",
    "$acl.AddAccessRule((New-Rule $user 'ReadAndExecute'))",
    `if (Test-Path -LiteralPath $work) { exit ${unsafe} }`,
    "[void][System.IO.Directory]::CreateDirectory($work, $acl)",
    `if (-not ((Get-Acl -LiteralPath $work).AreAccessRulesProtected) -or (@(Get-ChildItem -LiteralPath $work -Force).Count -ne 0)) { exit ${unsafe} }`,
    "try {",
  ];
  if (options.enableHypervisorPlatform) {
    lines.push(
      "  $dism = Join-Path ([Environment]::SystemDirectory) 'dism.exe'",
      `  & $dism /online /enable-feature /featurename:${HYPERVISOR_PLATFORM_FEATURE} /all /norestart`,
      "  $result.dism_exit_code = $LASTEXITCODE",
      `  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne ${RESTART_REQUIRED_EXIT_CODE}) { throw "dism exited with code $LASTEXITCODE" }`,
    );
  }
  if (options.installer) {
    lines.push(
      "  $installer = Join-Path $work 'qemu-setup.exe'",
      `  Copy-Item -LiteralPath ${psQuote(options.installer.path)} -Destination $installer`,
      "  $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()",
      `  if ($hash -ne ${psQuote(options.installer.sha256.toLowerCase())}) { throw "the QEMU installer is not the one that was verified (its SHA-256 is $hash)" }`,
      `  $setup = Start-Process -FilePath $installer -ArgumentList ${options.installer.silentArgs.map(psQuote).join(",")} -WorkingDirectory $work -Wait -PassThru`,
      "  $result.installer_exit_code = $setup.ExitCode",
      '  if ($setup.ExitCode -ne 0) { throw "the QEMU installer exited with code $($setup.ExitCode)" }',
      "  $result.install_dir = (Get-ItemProperty -LiteralPath 'HKLM:\\Software\\qemu64' -ErrorAction SilentlyContinue).Install_Dir",
    );
  }
  lines.push(
    "} catch {",
    "  $result.error = $_.Exception.Message",
    "}",
    "Remove-Item -LiteralPath (Join-Path $work 'qemu-setup.exe') -Force -ErrorAction SilentlyContinue",
    `[System.IO.File]::WriteAllText((Join-Path $work ${psQuote(ELEVATED_RESULT_FILE)}), ($result | ConvertTo-Json -Compress))`,
    "# Nothing in it runs any more: setup, as the normal user, reads the result and removes the directory.",
    "$done = Get-Acl -LiteralPath $work",
    "$done.AddAccessRule((New-Rule $user 'FullControl'))",
    "Set-Acl -LiteralPath $work -AclObject $done",
    "",
  );
  return lines.join("\r\n");
}

/**
 * The non-elevated launcher: ONE Start-Process -Verb RunAs -Wait, so the
 * person sees exactly one UAC prompt. Declining it makes Start-Process throw,
 * which is reported on stderr and as exit code 1.
 */
export function elevationLauncherScript(powershell: string, elevatedScript: string): string {
  const args = powershellArgs(elevatedScript).map(psQuote).join(",");
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $elevated = Start-Process -FilePath ${psQuote(powershell)} -Verb RunAs -Wait -PassThru -ArgumentList ${args}`,
    "  exit $elevated.ExitCode",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
    "",
  ].join("\r\n");
}

export interface ElevatedResult {
  dism_exit_code: number | null;
  installer_exit_code: number | null;
  /** Where the installer put QEMU, as its own registry value says. */
  install_dir: string | null;
  error: string | null;
}

/** The result file, written by Windows PowerShell; tolerates a byte order mark. */
export function parseElevatedResult(text: string): ElevatedResult {
  const value = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  const code = (key: string): number | null => {
    const v = value[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${key} is not an exit code: ${JSON.stringify(v)}`);
    return v;
  };
  const error = value.error;
  const installDir = value.install_dir;
  return {
    dism_exit_code: code("dism_exit_code"),
    installer_exit_code: code("installer_exit_code"),
    install_dir: typeof installDir === "string" && installDir.trim() !== "" ? installDir.trim() : null,
    error: typeof error === "string" && error.length > 0 ? error : null,
  };
}
