import { describe, expect, it } from "vitest";
import { allowedActions, computerView } from "../src/lib/computer";
import { formatBytes, formatDuration, formatUsd, maskProxy, startOfToday, statusTone } from "../src/lib/format";
import type { DotConfig } from "../src/lib/types";

const GIB = 1024 ** 3;

describe("format helpers", () => {
  it("formats binary sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(4 * GIB)).toBe("4.0 GiB");
    expect(formatBytes(200 * GIB)).toBe("200 GiB");
    expect(formatBytes(undefined)).toBe("-");
  });

  it("formats durations", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3 * 3600 + 120)).toBe("3h 2m");
    expect(formatDuration(2 * 86_400 + 3600)).toBe("2d 1h");
  });

  it("maps states to tones", () => {
    expect(statusTone("READY")).toBe("ok");
    expect(statusTone("FAILED")).toBe("error");
    expect(statusTone("WAITING_APPROVAL")).toBe("warn");
    expect(statusTone("STOPPED")).toBe("neutral");
    expect(statusTone("whatever")).toBe("neutral");
  });

  it("hides proxy credentials", () => {
    expect(maskProxy("http://user:secret@proxy.example:8080")).toBe("http://***@proxy.example:8080");
    expect(maskProxy("socks5://proxy.example:1080")).toBe("socks5://proxy.example:1080");
    expect(maskProxy(undefined)).toBe("");
  });
});

describe("computerView", () => {
  const config = { computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" } } as DotConfig;

  it("shows allocated resources and live usage from an embedded system answer", () => {
    const view = computerView(
      {
        state: "RUNNING",
        system: {
          hostname: "dot",
          uptime_s: 90,
          cpus: 2,
          mem_total_bytes: 4 * GIB,
          mem_available_bytes: 3 * GIB,
          disk_total_bytes: 40 * GIB,
          disk_free_bytes: 30 * GIB,
        },
      },
      config,
    );
    expect(view.state).toBe("RUNNING");
    expect(view.allocated).toEqual({ cpus: 2, memory: "4gb", disk: "40gb", idleTimeout: "15m" });
    expect(view.live?.memory).toEqual({ usedBytes: GIB, totalBytes: 4 * GIB, fraction: 0.25 });
    expect(view.live?.disk.fraction).toBe(0.25);
  });

  it("has no live usage for a stopped computer", () => {
    const view = computerView({ state: "STOPPED" }, config);
    expect(view.live).toBeNull();
    expect(view.allocated.cpus).toBe(2);
  });

  it("enables only the power actions that fit the state", () => {
    expect(allowedActions("STOPPED")).toEqual({ start: true, stop: false, reboot: false });
    expect(allowedActions("RUNNING")).toEqual({ start: false, stop: true, reboot: true });
    expect(allowedActions("STARTING")).toEqual({ start: false, stop: false, reboot: false });
  });
});

describe("spend", () => {
  it("shows cents, a trace as under a cent, and nothing as zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.4249)).toBe("$0.42");
    expect(formatUsd(12)).toBe("$12.00");
    expect(formatUsd(-1)).toBe("-");
    expect(formatUsd(Number.NaN)).toBe("-");
    expect(formatUsd(undefined)).toBe("-");
  });

  it("takes today to start at the local midnight", () => {
    const noon = new Date(2026, 9, 5, 12, 34, 56);
    const start = new Date(startOfToday(noon));
    expect(start.getFullYear()).toBe(2026);
    expect([start.getMonth(), start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([9, 5, 0, 0, 0]);
    expect(startOfToday(noon)).toMatch(/Z$/);
  });
});
