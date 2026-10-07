import type { DoctorCheck } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { doctorAnswer } from "@invisible-dots/vm-manager";
import { FOUND, healthyDoctor, QEMU_IMG } from "../../vm-manager/test/doctor-fakes.js";
import { doctorCommand } from "../src/doctor/command.js";
import { renderReport } from "../src/doctor/render.js";
import { EXIT } from "../src/exit.js";

const find = (results: DoctorCheck[], id: DoctorCheck["id"]) => results.find((r) => r.id === id)!;

describe("doctor report", () => {
  const sample: DoctorCheck[] = [
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
    const parsed = JSON.parse(json) as { ok: boolean; checks: DoctorCheck[] };
    expect(parsed.ok).toBe(false);
    expect(find(parsed.checks, "qemu-img")).toMatchObject({ status: "missing", fix: "invisible-dots setup" });
    expect(QEMU_IMG).toBe(FOUND.img);
  });
});
