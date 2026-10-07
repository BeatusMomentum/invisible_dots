import type { DoctorCheck } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { isReady, notReadyCount, preflightItems } from "../src/lib/preflight";

const HEALTHY = { status: "ok", database: "ok", version: "1.2.3", openrouter_configured: true, database_kind: "pglite", data_dir: "/home/me/.invisible-dots", logs_dir: "/home/me/.invisible-dots/logs" } as const;
const row = (id: DoctorCheck["id"], status: DoctorCheck["status"], detail = "fine", fix?: string): DoctorCheck => ({ id, label: id, status, detail, ...(fix ? { fix } : {}) });
const HOST_OK = { checks: [row("node", "ok"), row("qemu", "ok"), row("openrouter", "ok", "stored")] };

describe("preflightItems", () => {
  it("is all ok when the control plane answers, holds a key and the host is ready", () => {
    const items = preflightItems({ health: { health: HEALTHY }, host: HOST_OK });
    expect(items.map((item) => [item.id, item.state])).toEqual([["api", "ok"], ["database", "ok"], ["key", "ok"], ["node", "ok"], ["qemu", "ok"]]);
    expect(items[0]!.detail).toContain("1.2.3");
  });

  it("fails the key item, and only it, when no key is stored", () => {
    const items = preflightItems({ health: { health: { ...HEALTHY, openrouter_configured: false } }, host: HOST_OK });
    expect(items.slice(0, 3).map((item) => item.state)).toEqual(["ok", "ok", "failed"]);
    expect(items[2]!.detail).toMatch(/cannot answer until one is/);
  });

  it("says the key once: the doctor's own row of it is not shown", () => {
    const items = preflightItems({ health: { health: HEALTHY }, host: HOST_OK });
    expect(items.map((item) => item.id)).not.toContain("openrouter");
  });

  it("fails a host check that is missing or failed and carries the command that fixes it, as the doctor words it", () => {
    const items = preflightItems({
      health: { health: HEALTHY },
      host: { checks: [row("qemu", "missing", "not found on PATH", "invisible-dots setup"), row("disk", "failed", "3.0 GiB free", "free some space"), row("node", "ok", "24.1.0", "ignored")] },
    });
    const host = items.slice(3);
    expect(host.map((item) => [item.id, item.state, item.detail, item.fix])).toEqual([
      ["qemu", "failed", "not found on PATH", "invisible-dots setup"],
      ["disk", "failed", "3.0 GiB free", "free some space"],
      ["node", "ok", "24.1.0", undefined],
    ]);
  });

  it("fails the control plane with the reason, and says the rest was not checked, when it does not answer", () => {
    const items = preflightItems({ health: { error: "cannot reach the API" }, host: { error: "cannot reach the API" } });
    expect(items.map((item) => item.state)).toEqual(["failed", "unknown", "unknown", "unknown"]);
    expect(items[0]!.detail).toBe("cannot reach the API");
    expect(items[3]).toMatchObject({ id: "host", detail: "Not checked: the control plane does not answer." });
  });

  it("keeps the control plane's rows and says why the host report is missing when only that fails", () => {
    const items = preflightItems({ health: { health: HEALTHY }, host: { error: "the doctor could not run" } });
    expect(items.slice(0, 3).every((item) => item.state === "ok")).toBe(true);
    expect(items[3]).toMatchObject({ id: "host", state: "unknown", detail: "Not checked: the doctor could not run" });
  });
});

describe("isReady and notReadyCount", () => {
  it("is ready when every item is ok", () => {
    const items = preflightItems({ health: { health: HEALTHY }, host: HOST_OK });
    expect(isReady(items)).toBe(true);
    expect(notReadyCount(items)).toBe(0);
  });

  it("is not ready with a failed item, and counts it", () => {
    const items = preflightItems({ health: { health: { ...HEALTHY, openrouter_configured: false } }, host: { checks: [row("qemu", "missing", "not found", "invisible-dots setup")] } });
    expect(isReady(items)).toBe(false);
    expect(notReadyCount(items)).toBe(2);
  });

  it("does not count a check that was not made as ready", () => {
    const items = preflightItems({ health: { error: "down" }, host: { error: "down" } });
    expect(isReady(items)).toBe(false);
    expect(notReadyCount(items)).toBe(4);
  });
});
