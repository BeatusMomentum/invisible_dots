"use client";

import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { api } from "../../lib/api";
import { frameProblem } from "../../lib/computer";
import { formatDate } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ScreenView } from "./screen-view";
import { useFrame } from "./use-frame";

/** How often the desktop is read. */
const SCREEN_EVERY_MS = 3000;
/** A frame older than this is flagged: the reads keep failing or the page is not being refreshed. */
const STALE_AFTER_S = 15;

/** The newest picture of the Dot's desktop, kept current, with what the person can do with it: read it again, open it full size. */
export function FrameView({ dotId }: { dotId: string }) {
  const frame = useFrame(() => api.screenshot(dotId), "image/png", SCREEN_EVERY_MS, true);
  const now = useNow(1000);
  const problem = frame.error ? frameProblem(frame.error) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ScreenView
        className="min-h-0 flex-1"
        src={frame.url}
        alt="The current picture of the desktop on the Dot's computer"
        live={frame.url !== null && problem === null}
        staleAfterSeconds={STALE_AFTER_S}
        lastFrameAt={frame.takenAt}
        now={now}
        placeholder={problem ?? "Waiting for the first picture..."}
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
          {problem}
        </p>
      ) : null}
    </div>
  );
}
