import { describe, expect, it } from "vitest";
import {
  checkAcceleratorAccess,
  encodeCommand,
  HYPERVISOR_PLATFORM_STATE_SCRIPT,
  powershellArgs,
  powershellPath,
  type AccessDeps,
} from "../src/index.js";
import { fakeRunner, type Answer } from "./doctor-fakes.js";

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: /dev/kvm`), { code });
}

function fakeHost(options: { platform: NodeJS.Platform; respond?: (command: string, args: readonly string[]) => Answer; kvm?: string }) {
  const runner = fakeRunner((command, args) => options.respond?.(command, args) ?? {});
  const deps: AccessDeps = {
    platform: options.platform,
    env: { SystemRoot: "C:\\Windows" },
    run: runner.run,
    openReadWrite: async () => {
      if (options.kvm) throw errno(options.kvm);
    },
  };
  return { deps, calls: runner.calls };
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
  });
});

describe("the PowerShell the host runs", () => {
  it("is Windows PowerShell by absolute path, given a script as an encoded command that reads back to the script", () => {
    expect(Buffer.from(encodeCommand("Write-Output 1"), "base64").toString("utf16le")).toBe("Write-Output 1");
    expect(powershellArgs("x")).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand("x")]);
    expect(powershellPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({})).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(HYPERVISOR_PLATFORM_STATE_SCRIPT).toBe(`(Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='HypervisorPlatform'").InstallState`);
  });
});
