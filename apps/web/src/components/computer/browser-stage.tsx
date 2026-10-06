"use client";

import { GlobeIcon } from "lucide-react";
import type { IdentityActivity } from "../../lib/browser-activity";
import type { BrowserIdentity } from "../../lib/types";
import { UsingNow } from "./identity-card";
import { FrameView } from "./frame-view";

/**
 * The window of an open browser: a bar with the page the Dot last sent it to (the way a browser shows its address,
 * but read only, and as the Dot's calls reported it, so a page it reached by a link is not in it), and the live
 * picture under it. The person watches; the Dot drives.
 */
export function BrowserStage({ dotId, identity, activity, onClosed }: { dotId: string; identity: BrowserIdentity; activity: IdentityActivity; onClosed: () => void }) {
  return (
    <section aria-label={`Window of ${identity.name}`} className="space-y-2">
      <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm text-card-foreground">
        <GlobeIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="max-w-[45%] shrink-0 truncate font-medium" title={identity.name}>
          {identity.name}
        </span>
        <span aria-label="Page the Dot last opened" className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={activity.page ?? undefined}>
          {activity.page ?? "The Dot has not opened a page in this browser yet"}
        </span>
        {activity.usingNow ? <UsingNow /> : null}
      </div>
      <FrameView key={identity.id} dotId={dotId} source={{ kind: "browser", identityId: identity.id }} identity={identity} onClosed={onClosed} />
    </section>
  );
}
