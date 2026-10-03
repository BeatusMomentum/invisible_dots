import { describe, expect, it } from "vitest";
import {
  checkAcceleratorAccess,
  installHostPrerequisites,
  interpretElevatedResult,
  packageManagerFor,
  parseOsRelease,
  setupRefusal,
  type InstallDeps,
} from "../src/setup/install.js";
import { elevatedSetupScript, elevationLauncherScript, encodeCommand, HYPERVISOR_PLATFORM_STATE_SCRIPT, powershellArgs } from "../src/setup/powershell.js";
import type { WindowsQemuPin } from "../src/setup/qemu-pin.js";
import { fakeRunner, type Answer } from "./fakes.js";

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const PIN: WindowsQemuPin = {
  version: "10.0.0",
  url: "https://qemu.weilnetz.de/w64/2025/qemu-w64-setup-20250422.exe",
  sha256: "b".repeat(64),
  silentArgs: ["/S"],
};
const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: /dev/kvm`), { code });
}

interface HostOptions {
  platform: NodeJS.Platform;
  respond?: (command: string, args: readonly string[]) => Answer;
  kvm?: string;
  osRelease?: string;
  isRoot?: boolean;
  /** What the elevated session leaves in its result file; undefined writes nothing. */
  elevatedResult?: string;
}

function fakeHost(options: HostOptions) {
  const logs: string[] = [];
  const downloads: { pin: WindowsQemuPin; dest: string }[] = [];
  const removed: string[] = [];
  const work = "C:\\Users\\someone\\AppData\\Local\\Temp\\invisible-dots-setup-x1";
  const elevatedDir = "C:\\ProgramData\\invisible-dots-setup-0123abcd";
  const runner = fakeRunner((command, args) => options.respond?.(command, args) ?? {});
  const deps: InstallDeps = {
    platform: options.platform,
    env: { SystemRoot: "C:\\Windows", ProgramData: "C:\\ProgramData", ProgramW6432: "C:\\Program Files" },
    run: runner.run,
    openReadWrite: async () => {
      if (options.kvm) throw errno(options.kvm);
    },
    log: (line) => logs.push(line),
    readText: async (path) => {
      if (path === "/etc/os-release" && options.osRelease !== undefined) return options.osRelease;
      if (path === `${elevatedDir}\\result.json` && options.elevatedResult !== undefined) return options.elevatedResult;
      throw errno("ENOENT");
    },
    isRoot: options.isRoot ?? false,
    windowsQemuPin: () => PIN,
    makeTempDir: async () => work,
    removeDir: async (path) => {
      removed.push(path);
    },
    download: async (pin, dest) => {
      downloads.push({ pin, dest });
    },
    userSid: async () => "S-1-5-21-1-2-3-1001",
    uniqueName: () => "0123abcd",
  };
  return { deps, calls: runner.calls, logs, downloads, removed, work, elevatedDir };
}

describe("accelerator access (the host side of section 1.1)", () => {
  it("Linux: /dev/kvm read-write is ok; absent and not permitted are missing with their fixes", async () => {
    expect(await checkAcceleratorAccess(fakeHost({ platform: "linux" }).deps)).toEqual({
      id: "accelerator",
      label: "accelerator",
      status: "ok",
      detail: "/dev/kvm opens read-write",
    });
    expect(await checkAcceleratorAccess(fakeHost({ platform: "linux", kvm: "EACCES" }).deps)).toEqual({
      id: "accelerator",
      label: "accelerator",
      status: "missing",
      detail: "/dev/kvm exists but this user cannot open it read-write",
      fix: "sudo usermod -aG kvm $USER, then log out and in again (a new login is needed for the group to apply)",
    });
    expect(await checkAcceleratorAccess(fakeHost({ platform: "linux", kvm: "ENOENT" }).deps)).toMatchObject({
      status: "missing",
      detail: "/dev/kvm does not exist",
    });
    expect((await checkAcceleratorAccess(fakeHost({ platform: "linux", kvm: "EIO" }).deps)).status).toBe("failed");
  });

  it("Windows: reads the HypervisorPlatform state through Get-CimInstance, without elevation", async () => {
    const states: Record<string, string> = { "1\r\n": "ok", "2\r\n": "missing", "3\r\n": "failed", "": "failed" };
    for (const [stdout, status] of Object.entries(states)) {
      const host = fakeHost({ platform: "win32", respond: () => ({ stdout }) });
      expect((await checkAcceleratorAccess(host.deps)).status).toBe(status);
      expect(host.calls).toEqual([{ command: PS, args: powershellArgs(HYPERVISOR_PLATFORM_STATE_SCRIPT), options: { timeoutMs: 60_000 } }]);
    }
    const disabled = await checkAcceleratorAccess(fakeHost({ platform: "win32", respond: () => ({ stdout: "2\r\n" }) }).deps);
    expect(disabled).toEqual({
      id: "accelerator",
      label: "accelerator",
      status: "missing",
      detail: "the HypervisorPlatform feature is disabled",
      fix: "invisible-dots setup (enables it with one administrator prompt; a restart follows)",
    });
    const broken = await checkAcceleratorAccess(fakeHost({ platform: "win32", respond: () => ({ code: 1, stderr: "Get-CimInstance : Access denied\r\n" }) }).deps);
    expect(broken).toMatchObject({ status: "failed", detail: "cannot read the HypervisorPlatform feature state: Get-CimInstance : Access denied" });
  });

  it("any other host is refused", async () => {
    expect(await checkAcceleratorAccess(fakeHost({ platform: "darwin" }).deps)).toMatchObject({ status: "failed", detail: "darwin hosts are not supported" });
    expect((await installHostPrerequisites({ installQemu: true, enableAccelerator: false }, fakeHost({ platform: "darwin" }).deps)).kind).toBe("failed");
  });
});

describe("Linux install", () => {
  it("runs sudo apt-get install on apt systems with the terminal handed over, then checks /dev/kvm", async () => {
    const host = fakeHost({ platform: "linux", osRelease: UBUNTU });
    const outcome = await installHostPrerequisites({ installQemu: true, enableAccelerator: false }, host.deps);
    expect(outcome).toEqual({ kind: "done", lines: [] });
    expect(host.calls).toEqual([{ command: "sudo", args: ["apt-get", "install", "-y", "qemu-system-x86", "qemu-utils"], options: { inheritStdio: true } }]);
    expect(host.logs).toEqual(["$ sudo apt-get install -y qemu-system-x86 qemu-utils"]);
  });

  it("reports a failed apt-get", async () => {
    const host = fakeHost({ platform: "linux", osRelease: "ID=debian\n", respond: () => ({ code: 100 }) });
    const outcome = await installHostPrerequisites({ installQemu: true, enableAccelerator: false }, host.deps);
    expect(host.calls[0]).toMatchObject({ command: "sudo", args: ["apt-get", "install", "-y", "qemu-system-x86", "qemu-utils"] });
    expect(outcome).toEqual({ kind: "failed", lines: ["sudo apt-get install -y qemu-system-x86 qemu-utils failed (exit code 100)"] });
  });

  it("refuses root on Linux only: Windows setup never runs as an administrator", () => {
    expect(setupRefusal({ platform: "linux", isRoot: true })).toMatch(/not as root/);
    expect(setupRefusal({ platform: "linux", isRoot: false })).toBeNull();
    expect(setupRefusal({ platform: "win32", isRoot: false })).toBeNull();
  });

  it("only prints the dnf or pacman line elsewhere, and still checks /dev/kvm", async () => {
    const host = fakeHost({ platform: "linux", osRelease: 'ID=fedora\nPRETTY_NAME="Fedora Linux 42"\n', kvm: "EACCES" });
    const outcome = await installHostPrerequisites({ installQemu: true, enableAccelerator: false }, host.deps);
    expect(host.calls).toEqual([]);
    expect(outcome).toEqual({
      kind: "manual",
      lines: [
        "QEMU is not installed by setup on Fedora Linux 42; run:",
        "  sudo dnf install -y qemu-system-x86 qemu-img",
        "/dev/kvm exists but this user cannot open it read-write; fix:",
        "  sudo usermod -aG kvm $USER, then log out and in again (a new login is needed for the group to apply)",
      ],
    });
  });

  it("prints usermod and the new login when only /dev/kvm is not accessible", async () => {
    const outcome = await installHostPrerequisites({ installQemu: false, enableAccelerator: true }, fakeHost({ platform: "linux", kvm: "EACCES" }).deps);
    expect(outcome.kind).toBe("manual");
    expect(outcome.lines.join("\n")).toContain("sudo usermod -aG kvm $USER");
    expect(outcome.lines.join("\n")).toContain("a new login is needed");
  });

  it("reads the package manager from ID and ID_LIKE", () => {
    expect(parseOsRelease(UBUNTU)).toEqual({ id: "ubuntu", idLike: ["debian"], prettyName: "Ubuntu 24.04.3 LTS" });
    expect(packageManagerFor(parseOsRelease("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n"))).toEqual({ kind: "apt" });
    expect(packageManagerFor(parseOsRelease("ID=rocky\nID_LIKE=\"rhel centos fedora\"\n"))).toMatchObject({ line: "sudo dnf install -y qemu-system-x86 qemu-img" });
    expect(packageManagerFor(parseOsRelease("ID=endeavouros\nID_LIKE=arch\n"))).toMatchObject({ line: "sudo pacman -S --needed qemu-system-x86 qemu-img" });
    expect(packageManagerFor(parseOsRelease("ID=gentoo\n"))).toMatchObject({ kind: "print" });
    expect(packageManagerFor(parseOsRelease(""))).toMatchObject({ kind: "print" });
  });
});

describe("Windows install", () => {
  it("downloads and verifies the pinned installer, then runs dism and the installer in ONE elevated session; 3010 means restart", async () => {
    const host = fakeHost({ platform: "win32", elevatedResult: '\uFEFF{"dism_exit_code":3010,"installer_exit_code":0,"error":null}' });
    const outcome = await installHostPrerequisites({ installQemu: true, enableAccelerator: true }, host.deps);

    const installer = `${host.work}\\qemu-w64-setup-20250422.exe`;
    expect(host.downloads).toEqual([{ pin: PIN, dest: installer }]);
    const elevated = elevatedSetupScript({
      enableHypervisorPlatform: true,
      installer: { path: installer, sha256: PIN.sha256, silentArgs: ["/S"] },
      workDir: host.elevatedDir,
      userSid: "S-1-5-21-1-2-3-1001",
    });
    expect(host.calls).toEqual([{ command: PS, args: powershellArgs(elevationLauncherScript(PS, elevated)), options: { timeoutMs: 3_600_000 } }]);
    const launcher = Buffer.from(host.calls[0]!.args.at(-1)!, "base64").toString("utf16le");
    expect(launcher).toContain(`-Verb RunAs -Wait -PassThru`);
    expect(launcher).toContain(encodeCommand(elevated));

    expect(outcome).toEqual({
      kind: "restart",
      lines: [
        "QEMU installed",
        "the HypervisorPlatform feature is enabled; Windows must restart before it works",
        "restart Windows, then run: invisible-dots doctor",
      ],
    });
    // The elevated session's own directory goes too, once its result was read.
    expect(host.removed).toEqual([host.elevatedDir, host.work]);
    expect(host.logs).toEqual([
      `downloading the official QEMU 10.0.0 installer: ${PIN.url}`,
      `verified its SHA-256 (${PIN.sha256})`,
      "asking for administrator rights once, to enable the HypervisorPlatform feature (dism) and run the QEMU installer silently",
    ]);
  });

  it("enables only the feature without downloading anything when QEMU is already installed", async () => {
    const host = fakeHost({ platform: "win32", elevatedResult: '{"dism_exit_code":0,"installer_exit_code":null,"error":null}' });
    const outcome = await installHostPrerequisites({ installQemu: false, enableAccelerator: true }, host.deps);
    expect(host.downloads).toEqual([]);
    const launcher = Buffer.from(host.calls[0]!.args.at(-1)!, "base64").toString("utf16le");
    const elevated = Buffer.from(/'-EncodedCommand','([^']+)'/.exec(launcher)![1]!, "base64").toString("utf16le");
    expect(elevated).toContain("/featurename:HypervisorPlatform");
    expect(elevated).not.toContain("$installer");
    expect(outcome).toEqual({ kind: "done", lines: ["the HypervisorPlatform feature is enabled"] });
  });

  it("installs only QEMU when the feature is already on", async () => {
    const host = fakeHost({ platform: "win32", elevatedResult: '{"dism_exit_code":null,"installer_exit_code":0,"error":null}' });
    expect(await installHostPrerequisites({ installQemu: true, enableAccelerator: false }, host.deps)).toEqual({ kind: "done", lines: ["QEMU installed"] });
    expect(host.downloads).toHaveLength(1);
  });

  it("reports a declined UAC prompt, a failure inside the elevated session, and a download that does not verify", async () => {
    const declined = fakeHost({ platform: "win32", respond: () => ({ code: 1, stderr: "This operation was canceled by the user.\r\n" }) });
    expect(await installHostPrerequisites({ installQemu: false, enableAccelerator: true }, declined.deps)).toEqual({
      kind: "failed",
      lines: ["administrator rights were not granted (the prompt was declined); nothing was changed"],
    });
    expect(declined.removed).toEqual([declined.elevatedDir, declined.work]);

    const inside = fakeHost({ platform: "win32", elevatedResult: '{"dism_exit_code":50,"installer_exit_code":null,"error":"dism exited with code 50"}' });
    expect(await installHostPrerequisites({ installQemu: false, enableAccelerator: true }, inside.deps)).toEqual({
      kind: "failed",
      lines: ["the elevated step failed: dism exited with code 50"],
    });

    const tampered = fakeHost({ platform: "win32" });
    tampered.deps.download = async () => {
      throw new Error("https://example.invalid/q.exe hashes to 00, but the pin is bb");
    };
    await expect(installHostPrerequisites({ installQemu: true, enableAccelerator: true }, tampered.deps)).rejects.toThrow(/but the pin is/);
    expect(tampered.calls).toEqual([]);
    expect(tampered.removed).toEqual([tampered.elevatedDir, tampered.work]);
  });

  it("interprets the result file", () => {
    expect(interpretElevatedResult("not json").kind).toBe("failed");
    expect(interpretElevatedResult('{"dism_exit_code":3010,"installer_exit_code":null,"error":null}').kind).toBe("restart");
  });

  it("names the directory to set when the installer reused an earlier one invisible-dots does not search", () => {
    const env = { ProgramW6432: "C:\\Program Files" };
    const installedIn = (dir: string) => JSON.stringify({ dism_exit_code: null, installer_exit_code: 0, install_dir: dir, error: null });
    // The official directory (with the trailing separator the registry value has) needs nothing more.
    expect(interpretElevatedResult(installedIn("C:\\Program Files\\qemu\\"), env)).toEqual({
      kind: "done",
      lines: ["QEMU installed"],
    });
    expect(interpretElevatedResult(installedIn("D:\\Tools\\qemu"), env)).toEqual({
      kind: "done",
      lines: ["QEMU installed", "it went to D:\\Tools\\qemu, where an earlier QEMU was installed: set INVISIBLE_DOTS_QEMU_DIR=D:\\Tools\\qemu so invisible-dots uses it"],
    });
  });

  it("says the elevated step ran nothing when it could not make its own directory safely", async () => {
    const host = fakeHost({ platform: "win32", respond: () => ({ code: 2 }) });
    expect(await installHostPrerequisites({ installQemu: false, enableAccelerator: true }, host.deps)).toEqual({
      kind: "failed",
      lines: [`the elevated step could not create its own directory ${host.elevatedDir} for administrators only, so it ran nothing; run setup again`],
    });
  });
});
