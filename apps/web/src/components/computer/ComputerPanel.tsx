"use client";

import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import type { BrowserIdentity } from "../../lib/types";
import { cn } from "../../lib/utils";
import { useLiveRefresh } from "../events";
import { ErrorBox, useResource } from "../ui";
import { Button } from "../ui/button";
import { ScreenView } from "./screen-view";
import { useFrame } from "./use-frame";

/** How often the desktop is read, and a browser's window (the browser's own is quicker: a page changes under a call). */
const SCREEN_EVERY_MS = 3000;
const BROWSER_EVERY_MS = 2000;
/** A frame older than this is flagged: the reads keep failing or the page is not being refreshed. */
const STALE_AFTER_S = 15;

const IDENTITY_EVENTS = ["browser.identity.created", "browser.identity.deleted", "browser.identity.launched", "browser.identity.closed"];

/** The computer states in which the guest answers. */
export function computerIsUp(state: string | null | undefined): boolean {
  return state === "RUNNING" || state === "IDLE";
}

type Source = { kind: "screen" } | { kind: "browser"; identityId: string };

interface FrameProblem {
  /** What to tell the person. */
  text: string;
  /** The identity is not open any more: the list should be read again and the view go back to the screen. */
  closed: boolean;
}

/** What a failed read means for the person. */
export function frameProblem(error: unknown): FrameProblem {
  if (error instanceof ApiError) {
    if (error.code === "not_open") return { text: "This browser was closed.", closed: true };
    if (error.code === "busy") return { text: "The Dot is using this browser right now. The picture comes back when it is done.", closed: false };
    if (error.code === "computer_stopped") return { text: "The computer is not running.", closed: false };
  }
  return { text: error instanceof Error ? error.message : String(error), closed: false };
}

function FrameView({ dotId, source, identity, onClosed }: { dotId: string; source: Source; identity: BrowserIdentity | null; onClosed: () => void }) {
  const browser = source.kind === "browser";
  const frame = useFrame(
    () => (source.kind === "browser" ? api.getIdentityFrame(dotId, source.identityId) : api.screenshot(dotId)),
    browser ? "image/jpeg" : "image/png",
    browser ? BROWSER_EVERY_MS : SCREEN_EVERY_MS,
    true,
  );
  const now = useNow(1000);
  const problem = frame.error ? frameProblem(frame.error) : null;
  useEffect(() => {
    if (problem?.closed) onClosed();
  }, [problem?.closed, onClosed]);

  const subject = browser ? `the browser "${identity?.name ?? source.identityId}"` : "the desktop";
  return (
    <div className="space-y-2">
      <ScreenView
        src={frame.url}
        alt={`The current picture of ${subject} on the Dot's computer`}
        live={frame.url !== null && problem === null}
        staleAfterSeconds={STALE_AFTER_S}
        lastFrameAt={frame.takenAt}
        now={now}
        placeholder={problem ? problem.text : "Waiting for the first picture..."}
      />
      {problem && frame.url ? (
        <p role="status" className="text-xs text-warn">
          {problem.text}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="xs" onClick={() => void frame.refresh()} disabled={frame.pending}>
          <RefreshCwIcon className={cn(frame.pending && "animate-spin")} />
          Refresh
        </Button>
        {frame.url ? (
          <Button asChild variant="outline" size="xs">
            <a href={frame.url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Open full size
            </a>
          </Button>
        ) : null}
        {frame.takenAt ? <span className="text-xs text-muted-foreground">Taken {formatDate(frame.takenAt)}</span> : null}
      </div>
    </div>
  );
}

/**
 * The Dot's computer beside the chat: its desktop, or one of its open browsers, as the pictures the host reads from
 * the guest. The person only watches: there is no takeover, and the panel says so instead of showing a control that
 * would do nothing.
 */
export function ComputerPanel({ dotId, computerState }: { dotId: string; computerState: string | null }) {
  const up = computerIsUp(computerState);
  const identities = useResource(() => (up ? api.listIdentities(dotId) : Promise.resolve([])), `panel-identities:${dotId}:${up}`);
  useLiveRefresh(identities.reload, IDENTITY_EVENTS);
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
