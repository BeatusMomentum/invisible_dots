import { describe, expect, it } from "vitest";
import type { CheckResult, DoctorDeps } from "../src/doctor/checks.js";
import { EXIT } from "../src/exit.js";
import type { InstallDeps, InstallOutcome, InstallRequest } from "../src/setup/install.js";
import { nextSteps, runSetup } from "../src/setup/setup.js";
import { WEB_BUILD_COMMAND } from "../src/web.js";
import { FOUND, healthyDoctor } from "./fakes.js";

const MISSING_QEMU = async () => ({ searched: ["PATH"] });
const FEATURE_OFF: CheckResult = { id: "accelerator", label: "accelerator", status: "missing", detail: "the HypervisorPlatform feature is disabled", fix: "invisible-dots setup" };

/**
 * A setup run against fakes. `install` stands in for the platform module:
 * it records the request and may change what the second doctor run sees,
 * the way a real installation would.
 */
async function setup(options: {
  doctor: Partial<DoctorDeps>;
  outcome?: InstallOutcome;
  afterInstall?: Partial<DoctorDeps>;
}) {
  let text = "";
  const requests: InstallRequest[] = [];
  const { deps: doctor } = healthyDoctor(options.doctor);
  const install = {
    platform: "win32",
  } as unknown as InstallDeps;
  const code = await runSetup({
    doctor,
    install,
    out: (t) => (text += t),
    installPrerequisites: async (request) => {
      requests.push(request);
      Object.assign(doctor, options.afterInstall ?? {});
      return options.outcome ?? { kind: "done", lines: [] };
    },
  });
  return { code, text, requests };
}

describe("setup", () => {
  it("refuses to run as root on Linux, before it checks or installs anything", async () => {
    let text = "";
    let asked = false;
    const { deps: doctor, calls } = healthyDoctor();
    const code = await runSetup({
      doctor,
      install: { platform: "linux", isRoot: true } as unknown as InstallDeps,
      out: (t) => (text += t),
      installPrerequisites: async () => {
        asked = true;
        return { kind: "done", lines: [] };
      },
    });
    expect(code).toBe(EXIT.usage);
    expect(text).toMatch(/as the user who runs the server, not as root: it calls sudo itself/);
    expect(asked).toBe(false);
    expect(calls).toEqual([]);
  });

  it("installs nothing when QEMU and the accelerator are ready, and names what is left", async () => {
    const result = await setup({
      doctor: { images: async () => [{ id: "golden-image", label: "golden image", status: "missing", detail: "none", fix: "invisible-dots image build" }, { id: "runtime-image", label: "runtime ISO", status: "ok", detail: "ok" }] },
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.requests).toEqual([]);
    expect(result.text).toContain("QEMU and its accelerator are ready; nothing to install.");
    expect(result.text).toContain("  invisible-dots image build\n");
  });

  it("asks for QEMU and the feature together, then checks again and succeeds", async () => {
    const result = await setup({
      doctor: { findQemu: MISSING_QEMU, acceleratorAccess: async () => FEATURE_OFF },
      outcome: { kind: "done", lines: ["QEMU installed", "the HypervisorPlatform feature is enabled"] },
      afterInstall: { findQemu: async () => FOUND, acceleratorAccess: async () => ({ id: "accelerator", label: "accelerator", status: "ok", detail: "enabled" }) },
    });
    expect(result.requests).toEqual([{ installQemu: true, enableAccelerator: true }]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.text).toContain("QEMU installed\n");
    expect(result.text).toContain("checking again:");
    expect(result.text).toContain("this host is ready: invisible-dots server\n");
  });

  it("leaves the feature alone when the probe shows WHPX already works", async () => {
    const result = await setup({ doctor: { acceleratorAccess: async () => FEATURE_OFF } });
    expect(result.requests).toEqual([]);
    expect(result.code).toBe(EXIT.ok);
  });

  it("stops with exit 5 when Windows must restart", async () => {
    const { deps } = healthyDoctor();
    const versions = deps.run;
    const result = await setup({
      doctor: {
        acceleratorAccess: async () => FEATURE_OFF,
        run: async (command, args, options) =>
          args.includes("-accel") ? { code: 1, signal: null, stdout: "", stderr: "WHPX: No accelerator found, hr=80370102\n", timedOut: false } : versions(command, args, options),
      },
      outcome: { kind: "restart", lines: ["restart Windows, then run: invisible-dots doctor"] },
    });
    expect(result.requests).toEqual([{ installQemu: false, enableAccelerator: true }]);
    expect(result.code).toBe(EXIT.restart);
    expect(result.text).not.toContain("checking again");
    expect(result.text.trimEnd().endsWith("restart Windows, then run: invisible-dots doctor")).toBe(true);
  });

  it("exits 1 on a failed or manual step, and when the second check still fails", async () => {
    const failed = await setup({ doctor: { findQemu: MISSING_QEMU }, outcome: { kind: "failed", lines: ["the elevated step failed: boom"] } });
    expect(failed.code).toBe(EXIT.failed);
    expect(failed.text).toContain("the elevated step failed: boom\nsetup stopped");

    const manual = await setup({ doctor: { findQemu: MISSING_QEMU }, outcome: { kind: "manual", lines: ["  sudo dnf install -y qemu-system-x86 qemu-img"] } });
    expect(manual.code).toBe(EXIT.failed);
    expect(manual.text).toContain("then run: invisible-dots doctor");

    const still = await setup({ doctor: { findQemu: MISSING_QEMU } });
    expect(still.code).toBe(EXIT.failed);
    expect(still.text).toContain("QEMU or its accelerator is still not usable");
  });

  it("does not try to install anything when only the probe fails", async () => {
    const { deps } = healthyDoctor();
    const versions = deps.run;
    const result = await setup({
      doctor: {
        run: async (command, args, options) =>
          args.includes("-accel") ? { code: 1, signal: null, stdout: "", stderr: "WHPX: No accelerator found, hr=00000000\n", timedOut: false } : versions(command, args, options),
      },
    });
    expect(result.code).toBe(EXIT.failed);
    expect(result.requests).toEqual([]);
    expect(result.text).toContain("setup cannot fix this by installing something:\n  accelerator probe: qemu-system-x86_64 -accel kvm -cpu host -machine q35 failed: WHPX: No accelerator found");
  });

  it("names the server and the key as the next steps while they are missing", () => {
    const missingKey: CheckResult[] = [
      { id: "golden-image", label: "golden image", status: "ok", detail: "" },
      { id: "runtime-image", label: "runtime ISO", status: "ok", detail: "" },
      { id: "web", label: "web client", status: "ok", detail: "" },
      { id: "openrouter", label: "OpenRouter key", status: "failed", detail: "" },
    ];
    expect(nextSteps(missingKey)).toEqual([
      "invisible-dots server   (keep it running, then in another terminal:)",
      // One command for both hosts: "<" is a parser error in Windows PowerShell.
      "invisible-dots secret openrouter",
    ]);
  });

  it("names the web build as a next step while the web client is not built", () => {
    const notBuilt: CheckResult[] = [
      { id: "golden-image", label: "golden image", status: "ok", detail: "" },
      { id: "runtime-image", label: "runtime ISO", status: "ok", detail: "" },
      { id: "web", label: "web client", status: "missing", detail: "", fix: WEB_BUILD_COMMAND },
      { id: "openrouter", label: "OpenRouter key", status: "ok", detail: "" },
    ];
    expect(nextSteps(notBuilt)).toEqual(["npm run build --workspace @invisible-dots/web", "invisible-dots server"]);
  });
});
