import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess } from "@invisible-dots/vm-manager";
import {
  elevatedSetupScript,
  elevationLauncherScript,
  encodeCommand,
  HYPERVISOR_PLATFORM_STATE_SCRIPT,
  parseElevatedResult,
  powershellArgs,
  powershellPath,
  psQuote,
} from "../src/setup/powershell.js";

const SHA = "a".repeat(64);

const WORK = "C:\\ProgramData\\invisible-dots-setup-0123abcd";
const SID = "S-1-5-21-1-2-3-1001";

describe("generated PowerShell", () => {
  it("runs dism and a verified COPY of the installer in one elevated session, from a directory only administrators can change", () => {
    const script = elevatedSetupScript({
      enableHypervisorPlatform: true,
      installer: { path: "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\idots-1\\qemu-w64-setup-20250422.exe", sha256: SHA.toUpperCase(), silentArgs: ["/S"] },
      workDir: WORK,
      userSid: SID,
    });
    expect(script.split("\r\n")).toEqual([
      "# invisible-dots setup: the one step that needs administrator rights (architecture section 11.2).",
      "$ErrorActionPreference = 'Stop'",
      "$result = [ordered]@{ dism_exit_code = $null; installer_exit_code = $null; install_dir = $null; error = $null }",
      "$work = 'C:\\ProgramData\\invisible-dots-setup-0123abcd'",
      "$user = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-21-1-2-3-1001'",
      "function New-Rule($sid, $rights) { New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow') }",
      // Under the real ProgramData (not one an environment variable names), new, protected and empty.
      "if ((Split-Path -Parent $work) -ne [Environment]::GetFolderPath('CommonApplicationData')) { exit 2 }",
      "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
      "$acl.SetAccessRuleProtection($true, $false)",
      "$acl.AddAccessRule((New-Rule (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544') 'FullControl'))",
      "$acl.AddAccessRule((New-Rule (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18') 'FullControl'))",
      "$acl.AddAccessRule((New-Rule $user 'ReadAndExecute'))",
      "if (Test-Path -LiteralPath $work) { exit 2 }",
      "[void][System.IO.Directory]::CreateDirectory($work, $acl)",
      "if (-not ((Get-Acl -LiteralPath $work).AreAccessRulesProtected) -or (@(Get-ChildItem -LiteralPath $work -Force).Count -ne 0)) { exit 2 }",
      "try {",
      // dism through the system directory Windows reports, never $env:SystemRoot.
      "  $dism = Join-Path ([Environment]::SystemDirectory) 'dism.exe'",
      "  & $dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart",
      "  $result.dism_exit_code = $LASTEXITCODE",
      '  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "dism exited with code $LASTEXITCODE" }',
      // The copy is what is hashed and what runs, in the directory nobody else can write.
      "  $installer = Join-Path $work 'qemu-setup.exe'",
      "  Copy-Item -LiteralPath 'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\idots-1\\qemu-w64-setup-20250422.exe' -Destination $installer",
      "  $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()",
      `  if ($hash -ne '${SHA}') { throw "the QEMU installer is not the one that was verified (its SHA-256 is $hash)" }`,
      "  $setup = Start-Process -FilePath $installer -ArgumentList '/S' -WorkingDirectory $work -Wait -PassThru",
      "  $result.installer_exit_code = $setup.ExitCode",
      '  if ($setup.ExitCode -ne 0) { throw "the QEMU installer exited with code $($setup.ExitCode)" }',
      "  $result.install_dir = (Get-ItemProperty -LiteralPath 'HKLM:\\Software\\qemu64' -ErrorAction SilentlyContinue).Install_Dir",
      "} catch {",
      "  $result.error = $_.Exception.Message",
      "}",
      "Remove-Item -LiteralPath (Join-Path $work 'qemu-setup.exe') -Force -ErrorAction SilentlyContinue",
      // The result goes into the same private directory, never into one the user can redirect.
      "[System.IO.File]::WriteAllText((Join-Path $work 'result.json'), ($result | ConvertTo-Json -Compress))",
      "# Nothing in it runs any more: setup, as the normal user, reads the result and removes the directory.",
      "$done = Get-Acl -LiteralPath $work",
      "$done.AddAccessRule((New-Rule $user 'FullControl'))",
      "Set-Acl -LiteralPath $work -AclObject $done",
      "",
    ]);
    expect(script).not.toContain("$env:");
  });

  it("leaves out the step that is not needed", () => {
    const onlyFeature = elevatedSetupScript({ enableHypervisorPlatform: true, workDir: WORK, userSid: SID });
    expect(onlyFeature).toContain("dism.exe");
    expect(onlyFeature).not.toContain("$installer =");
    const onlyQemu = elevatedSetupScript({ enableHypervisorPlatform: false, installer: { path: "C:\\t\\q.exe", sha256: SHA, silentArgs: ["/S"] }, workDir: WORK, userSid: SID });
    expect(onlyQemu).not.toContain("dism.exe");
    expect(onlyQemu).toContain("-ArgumentList '/S'");
  });

  it("asks for elevation with one Start-Process -Verb RunAs -Wait and passes the script encoded", () => {
    const elevated = "Write-Output 'hi'";
    const launcher = elevationLauncherScript("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", elevated);
    expect(launcher.split("\r\n")).toEqual([
      "$ErrorActionPreference = 'Stop'",
      "try {",
      `  $elevated = Start-Process -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encodeCommand(elevated)}'`,
      "  exit $elevated.ExitCode",
      "} catch {",
      "  [Console]::Error.WriteLine($_.Exception.Message)",
      "  exit 1",
      "}",
      "",
    ]);
    expect(launcher.match(/Start-Process/g)).toHaveLength(1);
    expect(Buffer.from(encodeCommand(elevated), "base64").toString("utf16le")).toBe(elevated);
    expect(powershellArgs("x")).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand("x")]);
  });

  it("quotes every kind of single quote PowerShell recognises", () => {
    expect(psQuote("plain")).toBe("'plain'");
    expect(psQuote("it's")).toBe("'it''s'");
    expect(psQuote("a\u2019b\u2018c")).toBe("'a\u2019\u2019b\u2018\u2018c'");
    expect(powershellPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({})).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(HYPERVISOR_PLATFORM_STATE_SCRIPT).toBe(`(Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='HypervisorPlatform'").InstallState`);
  });

  it("reads the result file, with or without a byte order mark", () => {
    expect(parseElevatedResult('\uFEFF{"dism_exit_code":3010,"installer_exit_code":0,"error":null}')).toEqual({
      dism_exit_code: 3010,
      installer_exit_code: 0,
      install_dir: null,
      error: null,
    });
    expect(parseElevatedResult('{"dism_exit_code":null,"installer_exit_code":0,"install_dir":"D:\\\\q","error":null}').install_dir).toBe("D:\\q");
    expect(parseElevatedResult('{"dism_exit_code":null,"installer_exit_code":null,"error":"boom"}').error).toBe("boom");
    expect(() => parseElevatedResult('{"dism_exit_code":"x"}')).toThrow(/not an exit code/);
  });
});

/*
 * The same scripts run through the real Windows PowerShell where it exists:
 * the parser must accept every generated script, and the non-elevated parts
 * (quoting, the hash check, the result file) must behave as the code above
 * assumes. Nothing here elevates or changes the system.
 */
const windowsPowerShell = powershellPath(process.env);
const hasPowerShell = existsSync(windowsPowerShell);

// Each test starts Windows PowerShell a few times; under a parallel suite one start can take seconds.
describe.skipIf(!hasPowerShell)("generated PowerShell on a real Windows PowerShell", { timeout: 120_000 }, () => {
  let dir: string;
  beforeAll(async () => {
    // A quote and a space in the path: the cases quoting has to survive.
    dir = await mkdtemp(join(tmpdir(), "idots ps'q-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ps = (script: string) => runProcess(windowsPowerShell, powershellArgs(script), { timeoutMs: 60_000 });

  it("parses every generated script without errors", async () => {
    const elevated = elevatedSetupScript({ enableHypervisorPlatform: true, installer: { path: join(dir, "q.exe"), sha256: SHA, silentArgs: ["/S"] }, workDir: WORK, userSid: SID });
    for (const script of [elevated, elevationLauncherScript(windowsPowerShell, elevated), HYPERVISOR_PLATFORM_STATE_SCRIPT]) {
      const check = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput(${psQuote(script)}, [ref]$null, [ref]$errors); $errors.Count`;
      const result = await ps(check);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("0");
    }
  });

  it("runs nothing when its directory would not be directly under the real ProgramData", async () => {
    // A directory the normal user chose (here a temporary one): the session stops before it creates or runs anything.
    const installer = join(dir, "qemu-setup.exe");
    await writeFile(installer, "not the verified bytes");
    const workDir = join(dir, "elevated");
    const run = await ps(elevatedSetupScript({ enableHypervisorPlatform: false, installer: { path: installer, sha256: SHA, silentArgs: ["/S"] }, workDir, userSid: SID }));
    expect(run.code).toBe(2);
    expect(existsSync(workDir)).toBe(false);
  });

  it("reads the HypervisorPlatform state without administrator rights", async () => {
    const result = await ps(HYPERVISOR_PLATFORM_STATE_SCRIPT);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[1-4]?$/);
  });
});
