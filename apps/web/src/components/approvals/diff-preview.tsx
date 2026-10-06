// Derived from OpenDots (Shashankss1205) opendots/web/style.css and opendots/web/app.js at bb8db95, MIT; changed: written in React over this app's tokens (the added, removed and heading colors are the ok, danger and muted surfaces), lines scroll sideways instead of wrapping so that a long line keeps its shape, a long preview is cut at a number of lines and the rest opens on request, and the sign of each line is drawn apart from its text so that copying a line takes only the text.
"use client";

import { useState } from "react";
import type { DiffLine } from "../../lib/diff";
import { diffStats } from "../../lib/diff";
import { take } from "../../lib/range";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/** Lines shown before the rest opens on request. */
export const PREVIEW_LINES = 24;

const LINE_CLASS = {
  heading: "bg-muted text-muted-foreground",
  add: "bg-ok-soft text-ok",
  remove: "bg-danger-soft text-danger",
  context: "text-muted-foreground",
} as const;

const SIGN = { heading: "", add: "+", remove: "-", context: " " } as const;

const SIGN_WORD = { heading: "", add: "Added: ", remove: "Removed: ", context: "" } as const;

/** The lines of a change, each in the color of what it does to the file. */
export function DiffPreview({ lines, label }: { lines: readonly DiffLine[]; label: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : take(lines, PREVIEW_LINES);
  const stats = diffStats(lines);

  if (lines.length === 0) return <p className="text-xs text-muted-foreground">Nothing is added or removed.</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        <span className="text-ok">+{stats.added}</span> <span className="text-danger">-{stats.removed}</span>
      </p>
      <div role="group" aria-label={label} className="max-h-80 overflow-auto rounded-md border font-mono text-xs">
        <div className="w-max min-w-full py-1">
          {shown.map((line, index) => (
            <div key={index} data-kind={line.kind} className={cn("flex min-h-[1.5em] px-2 whitespace-pre", LINE_CLASS[line.kind])}>
              <span aria-hidden="true" className="w-4 shrink-0 select-none">
                {SIGN[line.kind]}
              </span>
              <span className="sr-only">{SIGN_WORD[line.kind]}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
      {lines.length > shown.length ? (
        <Button type="button" variant="outline" size="xs" onClick={() => setAll(true)}>
          Show the other {lines.length - shown.length} lines
        </Button>
      ) : null}
    </div>
  );
}
