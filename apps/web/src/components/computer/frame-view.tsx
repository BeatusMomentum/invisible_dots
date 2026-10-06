"use client";

import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { frameProblem } from "../../lib/computer";
import { formatDate } from "../../lib/format";
import type { BrowserIdentity } from "../../lib/types";
import { useNow } from "../../lib/use-now";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ScreenView } from "./screen-view";
import { useFrame } from "./use-frame";

/** How often the desktop is read, and a browser's window (the browser's own is quicker: a page changes under a call). */
const SCREEN_EVERY_MS = 3000;
const BROWSER_EVERY_MS = 2000;
/** A frame older than this is flagged: the reads keep failing or the page is not being refreshed. */
const STALE_AFTER_S = 15;

/** What a frame shows: the desktop, or the window of one identity. */
export type Source = { kind: "screen" } | { kind: "browser"; identityId: string };

/** The newest picture of a source, kept current, with what the person can do with it: read it again, open it full size. */
export function FrameView({ dotId, source, identity = null, onClosed }: { dotId: string; source: Source; identity?: BrowserIdentity | null; onClosed?: () => void }) {
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
    if (problem?.closed) onClosed?.();
  }, [problem?.closed, onClosed]);

  const subject = browser ? `the browser "${identity?.name ?? source.identityId}"` : "the desktop";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ScreenView
        className="min-h-0 flex-1"
        src={frame.url}
        alt={`The current picture of ${subject} on the Dot's computer`}
        live={frame.url !== null && problem === null}
        staleAfterSeconds={STALE_AFTER_S}
        lastFrameAt={frame.takenAt}
        now={now}
        placeholder={problem ? problem.text : "Waiting for the first picture..."}
      >
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
      </ScreenView>
      {problem && frame.url ? (
        <p role="status" className="text-xs text-warn">
          {problem.text}
        </p>
      ) : null}
    </div>
  );
}
