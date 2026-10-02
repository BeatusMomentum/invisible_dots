/** What the Computer tab shows: allocated resources from the config, live usage from the VM when it runs. */
import type { Computer, DotConfig, SystemAnswer, VmState } from "./types";

export interface Usage {
  usedBytes: number;
  totalBytes: number;
  /** 0..1 */
  fraction: number;
}

export interface ComputerView {
  state: VmState | "UNKNOWN";
  allocated: { cpus: number | null; memory: string | null; disk: string | null; idleTimeout: string | null };
  live: {
    hostname: string;
    uptimeSeconds: number;
    cpus: number;
    memory: Usage;
    disk: Usage;
  } | null;
}

function usage(total: number, free: number): Usage {
  const used = Math.max(0, total - free);
  return { usedBytes: used, totalBytes: total, fraction: total > 0 ? Math.min(1, used / total) : 0 };
}

/** The live figures are the guest's `GET /v1/system`, which the API embeds as `system` while the Dot is READY. */
export function computerView(
  computer: Pick<Computer, "state"> & { system?: SystemAnswer | null } | null,
  config: DotConfig | null,
): ComputerView {
  const system = computer?.system ?? null;
  return {
    state: computer?.state ?? "UNKNOWN",
    allocated: {
      cpus: config?.computer?.cpu ?? null,
      memory: config?.computer?.memory ?? null,
      disk: config?.computer?.disk ?? null,
      idleTimeout: config?.computer?.idle_timeout ?? null,
    },
    live: system
      ? {
          hostname: system.hostname,
          uptimeSeconds: system.uptime_s,
          cpus: system.cpus,
          memory: usage(system.mem_total_bytes, system.mem_available_bytes),
          disk: usage(system.disk_total_bytes, system.disk_free_bytes),
        }
      : null,
  };
}

/** Which power buttons make sense in a state. Unknown states enable everything and let the API decide. */
export function allowedActions(state: string): { start: boolean; stop: boolean; reboot: boolean } {
  switch (state) {
    case "STOPPED":
    case "ERROR":
      return { start: true, stop: state === "ERROR", reboot: false };
    case "RUNNING":
    case "IDLE":
      return { start: false, stop: true, reboot: true };
    case "PROVISIONING":
    case "STARTING":
    case "STOPPING":
    case "DELETING":
      return { start: false, stop: false, reboot: false };
    default:
      return { start: true, stop: true, reboot: true };
  }
}
