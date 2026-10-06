"use client";

import { useState } from "react";
import { api } from "../../lib/api";
import { IDENTITY_EVENTS, isComputerStopped } from "../../lib/computer";
import { identityLimits, identityOrder } from "../../lib/identity";
import { useNow } from "../../lib/use-now";
import { useDot } from "../DotShell";
import { ErrorAlert } from "../ErrorAlert";
import { useLiveRefresh } from "../events";
import { useResource } from "../ui";
import { Skeleton } from "../ui/skeleton";
import { BrowserStage } from "./browser-stage";
import { ComputerOff } from "./computer-off";
import { IdentityCard } from "./identity-card";
import { NewIdentityDialog } from "./new-identity-dialog";
import { useBrowserActivity } from "./use-browser-activity";

/**
 * The Dot's browsers: each identity as a card (open or closed, last used, the proxy with its password hidden, and
 * whether the Dot is working in it this moment), the window of an open one live, and the means to create, close and
 * delete them. The Dot opens and drives its browsers itself; the person watches and keeps house.
 */
export function BrowserTab() {
  const { dotId, dot } = useDot();
  const identities = useResource(() => api.listIdentities(dotId), `identities:${dotId}`);
  useLiveRefresh(identities.reload, IDENTITY_EVENTS);
  const limits = identityLimits(dot.data?.config);
  const list = identityOrder(identities.data ?? []);
  const open = list.filter((identity) => identity.status === "open");
  const [chosen, setChosen] = useState<string | null>(null);
  // The one the person picked while it is open; otherwise the first open one, so a browser that opens is seen at once.
  const watching = open.find((identity) => identity.id === chosen) ?? open[0] ?? null;
  const activity = useBrowserActivity(dotId, open.length > 0);
  const now = useNow(30_000);

  // The Computer page explains a computer it knows is off; this is the same answer from a computer that stopped meanwhile.
  if (isComputerStopped(identities.error)) return <ComputerOff dotId={dotId} state="STOPPED" what="Start the computer to see its browsers" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose space-y-1 text-sm text-muted-foreground">
          <p>The browsers the Dot uses. Each keeps its own cookies and logins. The Dot opens them and works in them; you can watch, close or delete them.</p>
          <p aria-label="Limits" className="text-xs">
            {identities.data === undefined ? "" : `${list.length} of ${limits.maxIdentities} browsers, ${open.length} of ${limits.maxOpen} open at once. When the Dot opens one more, the one it used longest ago is closed.`}
          </p>
          {dot.data !== undefined && !limits.managedByDot ? <p className="text-xs">The Dot cannot create or delete browsers itself, because its settings say you do. You still can, here.</p> : null}
        </div>
        <NewIdentityDialog dotId={dotId} existing={list.length} limits={limits} onCreated={identities.reload} />
      </div>

      <ErrorAlert error={identities.error} title="Could not load the browsers" />
      {identities.data === undefined && !identities.error ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {activity.failed ? (
        <p role="status" className="text-xs text-muted-foreground">
          What the Dot did in its browsers could not be read, so the pages and the marks that show it is working are missing.
        </p>
      ) : null}

      {watching !== null ? <BrowserStage dotId={dotId} identity={watching} activity={activity.of(watching.id)} onClosed={identities.reload} /> : null}

      {identities.data !== undefined && list.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="font-medium">No browsers yet</p>
          <p className="mt-1 text-sm text-muted-foreground">{limits.managedByDot ? "The Dot makes one when it needs to browse. You can make one too, with New browser." : "Make one with New browser; the Dot then uses it."}</p>
        </div>
      ) : null}
      {identities.data !== undefined && list.length > 0 && open.length === 0 ? <p className="text-sm text-muted-foreground">No browser is open. The Dot opens one when it needs it, and its window shows here.</p> : null}

      {list.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((identity) => (
            <li key={identity.id}>
              <IdentityCard
                dotId={dotId}
                identity={identity}
                activity={activity.of(identity.id)}
                watching={watching?.id === identity.id}
                now={now}
                onWatch={() => setChosen(identity.id)}
                onChanged={identities.reload}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
