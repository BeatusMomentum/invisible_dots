// Derived from assistant-ui packages/ui/src/components/react/assistant-ui/elements/memory-chips.tsx at 0bdf050, MIT; changed: this app's tokens instead of surfaces.tsx; a chip is a link to the note it names (the notes are the Dot's own and read only here, so there is no forget button and no onForget); there is no neutral "existing" chip (the page lists every note elsewhere, so this shows only what the Dot has just written) and the header always counts: "remembered N"; "added" and "updated" are tinted alike and the screen reader is told which; the fade-in is dropped under reduced motion.
"use client";

import { BrainIcon } from "lucide-react";
import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export interface MemoryChip {
  id: string;
  text: string;
  /** Where the chip leads: the note it names. */
  href: string;
  /** Both are tinted alike; the screen reader is told which. */
  change: "added" | "updated";
}

/** What the Dot has just remembered, as pills that lead to the notes; the header counts them. */
export function MemoryChips({ chips, className, ...props }: { chips: readonly MemoryChip[] } & Omit<ComponentProps<"div">, "children">) {
  return (
    <div data-slot="memory-chips" className={cn("space-y-2", className)} {...props}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <BrainIcon aria-hidden="true" className="size-3.5" />
        <span>remembered {chips.length}</span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <li key={chip.id} className="max-w-full motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-300">
            <Link
              href={chip.href}
              className="inline-flex max-w-full items-center rounded-full border border-transparent bg-info-soft px-2.5 py-0.5 font-mono text-xs text-info outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="truncate">{chip.text}</span>
              <span className="sr-only"> ({chip.change})</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
