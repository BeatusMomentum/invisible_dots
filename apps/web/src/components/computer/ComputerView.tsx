"use client";

import Link from "next/link";
import { computerIsUp } from "../../lib/computer";
import { COMPUTER_VIEW_LABELS, COMPUTER_VIEWS, computerHref, type ComputerQuery } from "../../lib/computer-view";
import { cn } from "../../lib/utils";
import { useDot } from "../DotShell";
import { Skeleton } from "../ui/skeleton";
import { BrowserTab } from "./browser-tab";
import { ComputerOff } from "./computer-off";
import { FilesTab } from "./files-tab";
import { ScreenTab } from "./screen-tab";
import { UsageTab } from "./usage-tab";

/** What each view says when the computer is not running; Usage reads while it is off, so it has none. */
const NEEDS_THE_COMPUTER = { screen: "Start the computer to see its screen", browser: "Start the computer to see its browsers", files: "Start the computer to see its files", usage: null } as const;

/**
 * The Computer page (S9): the Dot's screen, its browsers, its files and what the computer uses. The view is in the
 * address (`?view=`), so each is a link of its own. The first three need the computer running and say so when it is
 * not; the page follows the computer starting and stopping by itself.
 */
export function ComputerView({ query }: { query: ComputerQuery }) {
  const { dotId, dot } = useDot();
  const state = dot.data?.computer_state;

  return (
    <div className="space-y-5">
      <nav aria-label="Computer views">
        <ul className="inline-flex gap-1 rounded-lg bg-muted p-1">
          {COMPUTER_VIEWS.map((view) => (
            <li key={view}>
              <Link
                href={computerHref(dotId, { view })}
                aria-current={query.view === view ? "page" : undefined}
                className={cn(
                  "block rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  query.view === view && "bg-background font-medium text-foreground shadow-xs",
                )}
              >
                {COMPUTER_VIEW_LABELS[view]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

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
    case "browser":
      return <BrowserTab />;
    case "files":
      return <FilesTab dotId={dotId} query={query} />;
  }
}
