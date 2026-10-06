"use client";

import { PlayIcon } from "lucide-react";
import { allowedActions } from "../../lib/computer";
import { usePower } from "../dot/use-power";
import { Button } from "../ui/button";

/** What to say, for each state in which the guest does not answer. */
function explanation(state: string | null): string {
  switch (state) {
    case null:
    case "STOPPED":
      return "The computer is stopped, so there is nothing to look at.";
    case "PROVISIONING":
    case "STARTING":
      return `The computer is ${state.toLowerCase()}. This page fills in once it is running.`;
    case "STOPPING":
      return "The computer is stopping.";
    case "ERROR":
      return "The computer is in an error state. Starting it again is the way back.";
    default:
      return `The computer is ${state.toLowerCase()}.`;
  }
}

/** The state of a page that needs the Dot's computer running when it is not: the reason, and a Start button where one makes sense. */
export function ComputerOff({ dotId, state, what }: { dotId: string; state: string | null; what: string }) {
  const power = usePower({ dotId, taskRunning: false, onDone: () => {} });
  const canStart = state !== null && allowedActions(state).start;
  return (
    <div role="status" className="space-y-3 rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">{what}</p>
      <p className="text-sm text-muted-foreground">{explanation(state)}</p>
      {canStart ? (
        <Button type="button" disabled={power.pending} onClick={() => void power.act("start")}>
          <PlayIcon />
          Start the computer
        </Button>
      ) : null}
    </div>
  );
}
