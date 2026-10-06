"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api, computerAction, type ComputerAction } from "../../lib/api";

const DOING: Record<ComputerAction, string> = { start: "Starting the computer", stop: "Stopping the computer", reboot: "Rebooting the computer" };

/**
 * Start, stop or reboot a Dot's computer, for every control that offers it (the power menu, the error banner).
 * Stopping or rebooting asks first while a task is running, since it would cut the task off.
 */
export function usePower({ dotId, taskRunning, onDone }: { dotId: string; taskRunning: boolean; onDone: () => void }): { act: (action: ComputerAction) => Promise<void>; pending: boolean } {
  const [pending, setPending] = useState(false);

  async function act(action: ComputerAction) {
    if (action !== "start" && taskRunning && !window.confirm(`A task is running. ${action === "stop" ? "Stop" : "Reboot"} the computer anyway?`)) return;
    setPending(true);
    try {
      await computerAction(api, dotId, action);
      toast.success(DOING[action]);
      onDone();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  return { act, pending };
}
