"use client";

import { ChevronDownIcon, PlayIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import { allowedActions } from "../../lib/computer";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { usePower } from "./use-power";

const STATE_DOT: Record<string, string> = {
  RUNNING: "bg-ok",
  IDLE: "bg-ok",
  ERROR: "bg-danger",
  PROVISIONING: "bg-info",
  STARTING: "bg-info",
  STOPPING: "bg-info",
  DELETING: "bg-warn",
};

/**
 * The computer pill: its state, and a menu to start, stop or reboot it. Stopping asks first (it pauses the automations),
 * and rebooting asks while a task is running, since it would cut the task off.
 */
export function PowerMenu({ dotId, computerState, taskRunning, onDone }: { dotId: string; computerState: string | null; taskRunning: boolean; onDone: () => void }) {
  const { act, pending } = usePower({ dotId, taskRunning, onDone });
  const allowed = allowedActions(computerState ?? "");

  if (computerState === null) {
    return (
      <Button type="button" variant="outline" size="sm" disabled>
        No computer yet
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={pending} aria-label={`Computer: ${computerState}. Power menu`}>
          <span aria-hidden="true" className={cn("size-2 rounded-full bg-muted-foreground", STATE_DOT[computerState])} />
          {computerState}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!allowed.start} onSelect={() => void act("start")}>
          <PlayIcon />
          Start
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!allowed.reboot} onSelect={() => void act("reboot")}>
          <RotateCwIcon />
          Reboot
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!allowed.stop} onSelect={() => void act("stop")}>
          <SquareIcon />
          Stop
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
