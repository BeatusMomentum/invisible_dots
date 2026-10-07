"use client";

import { computerIsUp } from "@invisible-dots/shared/browser";
import { COMPUTER_VIEW_LABELS, COMPUTER_VIEWS, computerHref, type ComputerQuery } from "../../lib/computer-view";
import { useDot } from "../DotShell";
import { Skeleton } from "../ui/skeleton";
import { ViewTabs } from "../view-tabs";
import { ComputerOff } from "./computer-off";
import { FilesTab } from "./files-tab";
import { ScreenTab } from "./screen-tab";
import { UsageTab } from "./usage-tab";

/** What each view says when the computer is not running; Usage reads while it is off, so it has none. */
const NEEDS_THE_COMPUTER = { screen: "Start the computer to see its screen", files: "Start the computer to see its files", usage: null } as const;

/**
 * The Computer page (S9): the Dot's screen, its files and what the computer uses. The view is in the address
 * (`?view=`), so each is a link of its own. The screen and the files need the computer running and say so when it
 * is not; the page follows the computer starting and stopping by itself. The Dot's browsers have no view of their
 * own: an open one is a window of the desktop, on the screen.
 */
export function ComputerView({ query }: { query: ComputerQuery }) {
  const { dotId, dot } = useDot();
  const state = dot.data?.computer_state;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <ViewTabs label="Computer views" views={COMPUTER_VIEWS} labels={COMPUTER_VIEW_LABELS} current={query.view} hrefOf={(view) => computerHref(dotId, { view })} />

      <Body query={query} dotId={dotId} state={state} />
    </div>
  );
}

function Body({ query, dotId, state }: { query: ComputerQuery; dotId: string; state: string | null | undefined }) {
  if (query.view === "usage") return <UsageTab />;
  // The Dot's state is not known yet: nothing is asked of the computer until it is.
  if (state === undefined) return <Skeleton className="h-48 w-full" aria-busy="true" />;
  if (!computerIsUp(state)) return <ComputerOff dotId={dotId} state={state} what={NEEDS_THE_COMPUTER[query.view]} />;
  switch (query.view) {
    case "screen":
      return <ScreenTab dotId={dotId} />;
    case "files":
      return <FilesTab dotId={dotId} query={query} />;
  }
}
