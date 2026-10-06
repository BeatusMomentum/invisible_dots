"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/**
 * A status of the rail's foot as an icon with a colored dot: the words (`children`) are read by a screen reader and
 * shown, with any detail, in a tooltip on hover or keyboard focus, so the foot holds one line of icons and nothing is
 * said only by color.
 */
export function StatusIcon({ icon: Icon, dotClassName, tooltip, children }: { icon: LucideIcon; dotClassName: string; tooltip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          className="relative inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon aria-hidden="true" className="size-4" />
          <span aria-hidden="true" className={cn("absolute right-1.5 bottom-1.5 size-2 rounded-full ring-2 ring-card", dotClassName)} />
          <span className="sr-only">{children}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
