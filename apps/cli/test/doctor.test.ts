import { describe, expect, it } from "vitest";
import {
  acceleratorProbeArgs,
  checkDataDirectory,
  checkNode,
  MIN_FREE_BYTES,
  PROBE_TIMEOUT_MS,
  runDoctor,
  type CheckResult,
} from "../src/doctor/checks.js";
import { doctorCommand } from "../src/doctor/command.js";
import { renderReport } from "../src/doctor/render.js";
import { EXIT } from "../src/exit.js";
import { answer, FOUND, healthyDoctor, QEMU, QEMU_IMG } from "./fakes.js";

const ids = (results: CheckResult[]) => results.map((r) => r.id);
const find = (results: CheckResult[], id: CheckResult["id"]) => results.find((r) => r.id === id)!;

describe("doctor checks", () => {
  it("reports an unsupported host as a row, never by stopping the report", async () => {
    const { deps, calls } = healthyDoctor({
      accelerator: () => {
        throw new Error("invisible_dots does not run on darwin");
      },
      acceleratorAccess: async () => ({ id: "accelerator", label: "accelerator", status: "failed", detail: "darwin hosts are not supported", fix: "run invisible_dots on Linux or Windows (x86-64)" }),
    });
    const results = await runDoctor(deps);
    expect(ids(results)).toEqual(["node", "qemu", "qemu-img", "accelerator", "accelerator-probe", "disk", "golden-image", "runtime-image", "openrouter"]);
    expect(find(results, "accelerator")).toMatchObject({ status: "failed", detail: "darwin hosts are not supported" });
    expect(find(results, "accelerator-probe")).toMatchObject({ status: "failed", detail: expect.stringContaining("does not run on darwin") });
    expect(calls.filter((c) => c.args.includes("-accel"))).toEqual([]);
  });

  it("runs every check of section 11.1 in the contract's order", async () => {
    const results = await runDoctor(healthyDoctor().deps);
    expect(ids(results)).toEqual(["node", "qemu", "qemu-img", "accelerator", "accelerator-probe", "disk", "golden-image", "runtime-image", "openrouter"]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("probes the accelerator by running the firmware of an empty q35 machine until its reset ends QEMU", async () => {
    const { deps, calls } = healthyDoctor({ accelerator: () => "whpx" });
    const results = await runDoctor(deps);
    const probe = calls.find((c) => c.args.includes("-accel"))!;
    expect(probe.command).toBe(QEMU);
    expect(probe.args).toEqual([
      "-nodefaults", "-no-user-config", "-machine", "q35", "-accel", "whpx", "-cpu", "host",
      "-display", "none", "-no-reboot", "-boot", "reboot-timeout=0",
    ]); // prettier-ignore
    expect(probe.options).toEqual({ timeoutMs: PROBE_TIMEOUT_MS });
    expect(find(results, "accelerator-probe").detail).toBe("qemu-system-x86_64 -accel whpx -cpu host -machine q35 ran the firmware and exited");
    expect(acceleratorProbeArgs("kvm")).toContain("kvm");
  });

  it("never holds the probe before its first instruction or talks to a monitor", () => {
    const args = acceleratorProbeArgs("kvm");
    for (const flag of ["-S", "-qmp", "-monitor", "-mon", "-chardev"]) expect(args).not.toContain(flag);
  });

  it("reports QEMU and qemu-img missing with the setup fix, and does not probe", async () => {
    const { deps, calls } = healthyDoctor({ findQemu: async () => ({ searched: ["C:\\Program Files\\qemu", "C:\\a", "C:\\b"] }) });
    const results = await runDoctor(deps);
    expect(find(results, "qemu")).toEqual({
      id: "qemu",
      label: "QEMU",
      status: "missing",
      detail: "qemu-system-x86_64 not found in the official installer's directory or on PATH (3 directories searched)",
      fix: "invisible-dots setup",
    });
    expect(find(results, "qemu-img").status).toBe("missing");
    expect(find(results, "accelerator-probe")).toMatchObject({ status: "missing", detail: "not run: QEMU is not ready", fix: "invisible-dots setup" });
    expect(calls).toHaveLength(0);
  });

  it("says INVISIBLE_DOTS_QEMU_DIR was the only place searched while it is set", async () => {
    const { deps } = healthyDoctor({ findQemu: async () => ({ searched: ["D:\\tools\\qemu"], configured: true }) });
    expect(find(await runDoctor(deps), "qemu").detail).toBe(
      "qemu-system-x86_64 not found in INVISIBLE_DOTS_QEMU_DIR (D:\\tools\\qemu), the only place searched while it is set",
    );
  });

  it("fails a QEMU older than 8.2 and one that reports no version", async () => {
    const old = healthyDoctor();
    old.deps.run = async (command, args) =>
      answer(args[0] === "--version" ? { stdout: command === QEMU ? "QEMU emulator version 8.1.5 (Debian 1:8.1.5+ds-1)\n" : "qemu-img version 8.1.5\n" } : {});
    const results = await runDoctor(old.deps);
    expect(find(results, "qemu")).toMatchObject({ status: "failed", detail: `${QEMU} is version 8.1.5, older than 8.2` });
    expect(find(results, "qemu-img").status).toBe("ok");
    expect(find(results, "accelerator-probe")).toMatchObject({ status: "failed", detail: "not run: QEMU is not ready" });

    const broken = healthyDoctor();
    broken.deps.run = async () => answer({ code: 127, stderr: "error while loading shared libraries: libSDL2\n" });
    expect(find(await runDoctor(broken.deps), "qemu").detail).toBe(
      `${QEMU} --version did not report a version (error while loading shared libraries: libSDL2)`,
    );
  });

  it("probes even when the host-side check says missing, and gives the failure that check's fix", async () => {
    const missing: CheckResult = { id: "accelerator", label: "accelerator", status: "missing", detail: "/dev/kvm exists but this user cannot open it read-write", fix: "sudo usermod -aG kvm $USER" };
    const { deps, calls } = healthyDoctor({ acceleratorAccess: async () => missing });
    const versions = deps.run;
    deps.run = async (command, args, options) =>
      args.includes("-accel")
        ? answer({ code: 1, stderr: "qemu-system-x86_64: -accel kvm: Could not access KVM kernel module: Permission denied\n" })
        : versions(command, args, options);
    const results = await runDoctor(deps);
    expect(find(results, "accelerator")).toEqual(missing);
    expect(find(results, "accelerator-probe")).toEqual({
      id: "accelerator-probe",
      label: "accelerator probe",
      status: "failed",
      detail: "qemu-system-x86_64 -accel kvm -cpu host -machine q35 failed: qemu-system-x86_64: -accel kvm: Could not access KVM kernel module: Permission denied",
      fix: "sudo usermod -aG kvm $USER",
    });
    expect(calls).toHaveLength(2);
  });

  it("reports the accelerator ok when the probe contradicts a host-side missing (WHPX without HypervisorPlatform)", async () => {
    const { deps } = healthyDoctor({
      accelerator: () => "whpx",
      acceleratorAccess: async () => ({ id: "accelerator", label: "accelerator", status: "missing", detail: "the HypervisorPlatform feature is disabled", fix: "invisible-dots setup" }),
    });
    const results = await runDoctor(deps);
    expect(find(results, "accelerator")).toEqual({
      id: "accelerator",
      label: "accelerator",
      status: "ok",
      detail: "the HypervisorPlatform feature is disabled, but the probe below shows QEMU uses the accelerator",
    });
    expect(find(results, "accelerator-probe").status).toBe("ok");
  });

  it("fails the probe when it does not exit by itself: the virtual CPU never ran the firmware to its reset", async () => {
    const hanging = healthyDoctor();
    const versions = hanging.deps.run;
    hanging.deps.run = async (command, args, options) =>
      args.includes("-accel") ? answer({ code: null, signal: "SIGKILL", timedOut: true }) : versions(command, args, options);
    expect(find(await runDoctor(hanging.deps), "accelerator-probe")).toMatchObject({
      status: "failed",
      detail: "qemu-system-x86_64 -accel kvm -cpu host -machine q35 failed: did not exit within 30 s, so the virtual CPU does not run",
      fix: "enable hardware virtualization (Intel VT-x or AMD-V) in the firmware settings; after enabling the accelerator, restart the computer",
    });

    // Measured on Windows with QEMU 11.1: a refused vCPU leaves QEMU running with this on stderr.
    const paused = healthyDoctor();
    paused.deps.run = async (command, args, options) =>
      args.includes("-accel") ? answer({ code: null, signal: "SIGKILL", timedOut: true, stderr: "WHPX: Unexpected VP exit code 4\n" }) : versions(command, args, options);
    expect(find(await runDoctor(paused.deps), "accelerator-probe").detail).toBe(
      "qemu-system-x86_64 -accel kvm -cpu host -machine q35 failed: did not exit within 30 s, so the virtual CPU does not run (QEMU said: WHPX: Unexpected VP exit code 4)",
    );
  });

  it("turns a check that throws into a failed line instead of ending the report", async () => {
    const { deps } = healthyDoctor({
      freeSpace: async () => {
        throw new Error("statfs exploded");
      },
      images: async () => {
        throw new Error("readdir exploded");
      },
      findQemu: async () => {
        throw new Error("PATH unreadable");
      },
    });
    const results = await runDoctor(deps);
    expect(results).toHaveLength(9);
    expect(find(results, "disk")).toMatchObject({ status: "failed", detail: "the check itself failed: statfs exploded" });
    expect(find(results, "golden-image").status).toBe("failed");
    expect(find(results, "runtime-image").status).toBe("failed");
    expect(find(results, "qemu").detail).toBe("qemu-system-x86_64 not found (the search failed: PATH unreadable)");
  });

  it("checks Node and free space against their minimums", () => {
    expect(checkNode("24.0.0").status).toBe("ok");
    expect(checkNode("22.11.0")).toMatchObject({ status: "failed", fix: "install Node 24 or newer from https://nodejs.org" });
    expect(checkDataDirectory("/data", { path: "/data", bytes: MIN_FREE_BYTES }).status).toBe("ok");
    expect(checkDataDirectory("/data", { path: "/data", bytes: 5 * 1024 ** 3 })).toEqual({
      id: "disk",
      label: "data directory",
      status: "failed",
      detail: "5.0 GiB free at /data, less than 20.0 GiB",
      fix: "free some space, or set INVISIBLE_DOTS_HOME to a directory on a larger disk",
    });
  });

  it("refuses a data directory QEMU cannot be given, before any build or Dot does", async () => {
    // The default home sits under the account name; on Windows QEMU cannot open a path with an accent in it.
    const { deps } = healthyDoctor({ home: "C:\\Users\\Jos\u00e9\\.invisible-dots" });
    expect(find(await runDoctor(deps), "disk")).toMatchObject({
      status: "failed",
      fix: "set INVISIBLE_DOTS_HOME to a directory whose path is plain ASCII without commas",
    });
    expect(checkDataDirectory("/srv/a,b", { path: "/srv", bytes: MIN_FREE_BYTES }).detail).toMatch(/comma/);
  });
});

describe("doctor report", () => {
  const sample: CheckResult[] = [
    { id: "node", label: "Node", status: "ok", detail: "24.19.0" },
    { id: "qemu", label: "QEMU", status: "missing", detail: "qemu-system-x86_64 not found", fix: "invisible-dots setup" },
    { id: "disk", label: "data directory", status: "failed", detail: "1.0 GiB free at /data", fix: "free some space" },
    { id: "openrouter", label: "OpenRouter key", status: "ok", detail: "stored" },
  ];

  it("prints one aligned line per check, a fix line under each that is not ok, and a count", () => {
    expect(renderReport(sample)).toBe(
      [
        "ok       Node            24.19.0",
        "missing  QEMU            qemu-system-x86_64 not found",
        "                         fix: invisible-dots setup",
        "failed   data directory  1.0 GiB free at /data",
        "                         fix: free some space",
        "ok       OpenRouter key  stored",
        "4 checks: 2 ok, 1 missing, 1 failed",
        "",
      ].join("\n"),
    );
    expect(renderReport([sample[0]!, sample[3]!]).endsWith("all 2 checks ok\n")).toBe(true);
  });

  it("exits 0 only when every check is ok, and prints JSON with --json", async () => {
    let text = "";
    expect(await doctorCommand(healthyDoctor().deps, { json: false }, (t) => (text += t))).toBe(EXIT.ok);
    expect(text.endsWith("all 9 checks ok\n")).toBe(true);

    let json = "";
    const missing = healthyDoctor({ findQemu: async () => ({ ...FOUND, img: undefined }) }).deps;
    expect(await doctorCommand(missing, { json: true }, (t) => (json += t))).toBe(EXIT.failed);
    const parsed = JSON.parse(json) as { ok: boolean; checks: CheckResult[] };
    expect(parsed.ok).toBe(false);
    expect(find(parsed.checks, "qemu-img")).toMatchObject({ status: "missing", fix: "invisible-dots setup" });
    expect(QEMU_IMG).toBe(FOUND.img);
  });
});
