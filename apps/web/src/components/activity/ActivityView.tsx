"use client";

import { DownloadIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { exportName, matchesSearch, toJsonl } from "../../lib/activity";
import { EVENT_FAMILIES, FAMILY_LABELS, viewEvent, type EventFamily } from "../../lib/events/view";
import { saveFile } from "../../lib/save-file";
import { useDot } from "../DotShell";
import { ErrorAlert } from "../ErrorAlert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { ActivityRow } from "./activity-row";
import { useActivityLog } from "./use-activity-log";

/**
 * The Activity page (S11): everything that was logged about the Dot, as readable lines. The families chosen narrow
 * what is read from the control plane (a family that is not chosen is never fetched); the search narrows what has
 * been read, by the words of the lines; the newest page is read first and older ones on request, so the cost does not
 * grow with the age of the Dot. The export is the events on screen, as the log stores them.
 */
export function ActivityView() {
  const { dotId } = useDot();
  const [families, setFamilies] = useState<readonly EventFamily[]>([]);
  const [search, setSearch] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const log = useActivityLog(dotId, families);

  const rows = useMemo(() => log.events.map((event) => ({ event, view: viewEvent(event) })).filter(({ view }) => matchesSearch(view, search)), [log.events, search]);
  const shown = newestFirst ? [...rows].reverse() : rows;
  const searching = search.trim() !== "";
  const exported = rows.map((row) => row.event);

  const toggle = (family: EventFamily) => setFamilies((chosen) => (chosen.includes(family) ? chosen.filter((f) => f !== family) : [...chosen, family]));

  // Older events are at the end of the list when it runs newest first, and at its start when it runs oldest first.
  const older = log.hasOlder ? (
    <Button type="button" variant="outline" size="sm" disabled={log.loading} onClick={log.loadMore}>
      {log.loading ? "Loading..." : "Load older events"}
    </Button>
  ) : log.events.length > 0 && !log.loading && !log.error ? (
    <p className="text-sm text-muted-foreground">That is the start of the log.</p>
  ) : null;

  return (
    <section aria-label="Activity" className="space-y-4">
      <div className="space-y-3">
        <div role="group" aria-label="Show events of" className="flex flex-wrap gap-1.5">
          <Button type="button" size="xs" variant={families.length === 0 ? "default" : "outline"} aria-pressed={families.length === 0} onClick={() => setFamilies([])}>
            All
          </Button>
          {EVENT_FAMILIES.map((family) => (
            <Button key={family} type="button" size="xs" variant={families.includes(family) ? "default" : "outline"} aria-pressed={families.includes(family)} onClick={() => toggle(family)}>
              {FAMILY_LABELS[family]}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="search"
            aria-label="Search the events read so far"
            placeholder="Search the events read so far"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <div className="flex items-center gap-2">
            <Switch id="activity-newest-first" checked={newestFirst} onCheckedChange={setNewestFirst} />
            <Label htmlFor="activity-newest-first" className="text-sm font-normal">
              Newest first
            </Label>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exported.length === 0}
            onClick={() => saveFile(exportName(dotId, exported), toJsonl(exported), "application/x-ndjson")}
            className="sm:ml-auto"
          >
            <DownloadIcon />
            Export {exported.length} {exported.length === 1 ? "event" : "events"}
          </Button>
        </div>
        <p role="status" className="min-h-4 text-xs text-muted-foreground">
          {log.events.length === 0 ? "" : searching ? `${rows.length} of the ${log.events.length} events read so far match.` : `${log.events.length} events read so far.`}
        </p>
      </div>

      <ErrorAlert error={log.error} title="Could not load events" />
      {log.error ? (
        <Button type="button" variant="outline" size="sm" onClick={log.loadMore}>
          Try again
        </Button>
      ) : null}

      {!newestFirst ? older : null}
      {log.loading && log.events.length === 0 ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : shown.length === 0 ? (
        log.error ? null : <p className="text-sm text-muted-foreground">{emptyText(families, searching, log.events.length)}</p>
      ) : (
        <ol aria-label="Events" className="space-y-1.5">
          {shown.map(({ event, view }) => (
            <ActivityRow key={event.id} view={view} event={event} />
          ))}
        </ol>
      )}
      {newestFirst ? older : null}
    </section>
  );
}

function emptyText(families: readonly EventFamily[], searching: boolean, read: number): string {
  if (searching && read > 0) return "No event read so far says that. Older events may: load them, or search for other words.";
  if (families.length > 0) return `No ${families.map((f) => FAMILY_LABELS[f].toLowerCase()).join(" or ")} events yet.`;
  return "No events yet.";
}
