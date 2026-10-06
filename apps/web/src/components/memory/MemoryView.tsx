"use client";

import { computerIsUp } from "@invisible-dots/shared/browser";
import { MEMORY_VIEW_LABELS, MEMORY_VIEWS, memoryHref, type MemoryQuery } from "../../lib/memory-view";
import { ComputerOff } from "../computer/computer-off";
import { useDot } from "../DotShell";
import { Skeleton } from "../ui/skeleton";
import { ViewTabs } from "../view-tabs";
import { AutomationsTab } from "./automations-tab";
import { MemorySwitch } from "./memory-switch";
import { NotesTab } from "./notes-tab";

/** What each view says when the computer is not running: both read the Dot's own computer. */
const NEEDS_THE_COMPUTER = { notes: "Start the computer to read its notes", automations: "Start the computer to see its automations" } as const;

/**
 * The Memory page (S10): what the Dot keeps for later and what it does on its own. Notes are the files it wrote under
 * its memory folder, read only; Automations are the jobs its cron tool made, which the person can pause or delete.
 * The view and the open note are in the address. Both read the Dot's computer, so a computer that is not running is
 * said, with a Start button, and the page follows it starting.
 */
export function MemoryView({ query }: { query: MemoryQuery }) {
  const { dotId, dot } = useDot();
  const state = dot.data?.computer_state;

  return (
    <div className="space-y-5">
      <ViewTabs label="Memory views" views={MEMORY_VIEWS} labels={MEMORY_VIEW_LABELS} current={query.view} hrefOf={(view) => memoryHref(dotId, { view })} />
      {query.view === "notes" ? <MemorySwitch /> : null}
      <Body query={query} dotId={dotId} state={state} />
    </div>
  );
}

function Body({ query, dotId, state }: { query: MemoryQuery; dotId: string; state: string | null | undefined }) {
  // The Dot's state is not known yet: nothing is asked of the computer until it is.
  if (state === undefined) return <Skeleton className="h-48 w-full" aria-busy="true" />;
  if (!computerIsUp(state)) return <ComputerOff dotId={dotId} state={state} what={NEEDS_THE_COMPUTER[query.view]} />;
  return query.view === "notes" ? <NotesTab dotId={dotId} open={query.note} /> : <AutomationsTab dotId={dotId} />;
}
