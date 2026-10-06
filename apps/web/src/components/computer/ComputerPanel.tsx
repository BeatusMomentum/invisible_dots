"use client";

import { useEffect, useState } from "react";
import { computerIsUp, IDENTITY_EVENT_TYPES } from "@invisible-dots/shared/browser";
import { api } from "../../lib/api";
import { useLiveRefresh } from "../events";
import { ErrorBox, useResource } from "../ui";
import { Button } from "../ui/button";
import { FrameView, type Source } from "./frame-view";

/**
 * The Dot's computer beside the chat: its desktop, or one of its open browsers, as the pictures the host reads from
 * the guest. The person only watches: there is no takeover, and the panel says so instead of showing a control that
 * would do nothing.
 */
export function ComputerPanel({ dotId, computerState }: { dotId: string; computerState: string | null }) {
  const up = computerIsUp(computerState);
  const identities = useResource(() => (up ? api.listIdentities(dotId) : Promise.resolve([])), `panel-identities:${dotId}:${up}`);
  useLiveRefresh(identities.reload, IDENTITY_EVENT_TYPES);
  const [source, setSource] = useState<Source>({ kind: "screen" });

  const open = (identities.data ?? []).filter((identity) => identity.status === "open");
  const chosen = source.kind === "browser" ? open.find((identity) => identity.id === source.identityId) ?? null : null;
  // A browser that closed (the Dot closed it, or it ended) leaves the list: the view goes back to the desktop.
  useEffect(() => {
    if (source.kind === "browser" && identities.data !== undefined && chosen === null) setSource({ kind: "screen" });
  }, [source, chosen, identities.data]);

  if (!up) {
    return (
      <section aria-label="The Dot's computer" className="space-y-2 text-sm">
        <h2 className="font-medium">Computer</h2>
        <p className="text-muted-foreground">
          {computerState === null || computerState === "STOPPED"
            ? "The computer is stopped. Start it from the header to watch the Dot work."
            : `The computer is ${computerState.toLowerCase()}. The picture shows once it is running.`}
        </p>
      </section>
    );
  }

  const sourceKey = source.kind === "browser" ? `browser:${source.identityId}` : "screen";
  return (
    <section aria-label="The Dot's computer" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Computer</h2>
        <span className="text-xs text-muted-foreground">The Dot has control. You are watching.</span>
      </div>
      <div role="group" aria-label="What to watch" className="flex flex-wrap gap-1.5">
        <Button type="button" size="xs" variant={source.kind === "screen" ? "default" : "outline"} aria-pressed={source.kind === "screen"} onClick={() => setSource({ kind: "screen" })}>
          Desktop
        </Button>
        {open.map((identity) => {
          const active = source.kind === "browser" && source.identityId === identity.id;
          return (
            <Button key={identity.id} type="button" size="xs" variant={active ? "default" : "outline"} aria-pressed={active} onClick={() => setSource({ kind: "browser", identityId: identity.id })}>
              Browser: {identity.name}
            </Button>
          );
        })}
      </div>
      <ErrorBox error={identities.error} title="Could not list the browsers" />
      <FrameView key={sourceKey} dotId={dotId} source={source} identity={chosen} onClosed={identities.reload} />
    </section>
  );
}
