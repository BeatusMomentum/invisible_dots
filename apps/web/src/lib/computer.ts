/** What the Computer page shows: allocated resources from the config, live usage from the VM when it runs. */
import { COMPUTER_STOPPED, computerIsUp, FRAME_ERROR_CODES } from "@invisible-dots/shared/browser";
import { ApiError } from "./api";
import type { Computer, DotConfig, SystemAnswer, VmState } from "./types";

/** The routes that reach into the Dot's computer (identities, files, tools) answer 409 `computer_stopped` while it is off. */
export function isComputerStopped(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === COMPUTER_STOPPED;
}

export interface FrameProblem {
  /** What to tell the person. */
  text: string;
  /** The identity is not open any more: the list should be read again and the view go back to the screen. */
  closed: boolean;
}

/** What a failed read of a picture (the desktop, or an identity's window) means for the person. */
export function frameProblem(error: unknown): FrameProblem {
  if (error instanceof ApiError) {
    if (error.code === FRAME_ERROR_CODES.notOpen) return { text: "This browser was closed.", closed: true };
    if (error.code === FRAME_ERROR_CODES.busy) return { text: "The Dot is using this browser right now. The picture comes back when it is done.", closed: false };
    if (error.code === COMPUTER_STOPPED) return { text: "The computer is not running.", closed: false };
  }
  return { text: error instanceof Error ? error.message : String(error), closed: false };
}

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

/**
 * What the person is asked before a power action that is not a start. Stopping says what it costs: a computer the
 * person stopped runs none of its automations until the person starts it again (architecture section 9.5).
 */
export function confirmText(action: "stop" | "reboot"): string {
  return action === "stop"
    ? "Stop this Dot's computer? Its automations do not run while it is stopped; start it again to resume them."
    : "Reboot this Dot's computer?";
}

/** Which power buttons make sense in a state. Unknown states enable everything and let the API decide. */
export function allowedActions(state: string): { start: boolean; stop: boolean; reboot: boolean } {
  switch (state) {
    case "STOPPED":
    case "ERROR":
      return { start: true, stop: state === "ERROR", reboot: false };
    case "RUNNING":
    case "IDLE":
      // The host reboots only a computer whose guest answers.
      return { start: false, stop: true, reboot: computerIsUp(state) };
    case "PROVISIONING":
    case "STARTING":
    case "STOPPING":
    case "DELETING":
      return { start: false, stop: false, reboot: false };
    default:
      return { start: true, stop: true, reboot: true };
  }
}

/** The task is cut off if the computer goes down now: the Dot is running one, or waits on an answer inside one. */
export function taskRunning(status: string): boolean {
  return status === "RUNNING" || status === "WAITING_APPROVAL";
}
