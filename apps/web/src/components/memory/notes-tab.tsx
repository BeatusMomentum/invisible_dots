"use client";

import { FileTextIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { isComputerStopped } from "../../lib/computer";
import { formatBytes, formatDate } from "../../lib/format";
import { memoryHref } from "../../lib/memory-view";
import { changeOf, filterNotes, isMarkdown, loadNotes, noteEntry, noteFolderPath, writtenKey, type Note, type NoteChange } from "../../lib/notes";
import { relativeTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { ComputerOff } from "../computer/computer-off";
import { FilePreview } from "../computer/file-preview";
import { MemoryChips, type MemoryChip } from "../elements/memory-chips";
import { ErrorAlert } from "../ErrorAlert";
import { useLiveEvents, useLiveRefresh } from "../events";
import { useResource } from "../ui";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";

/** What the Dot does that adds or changes notes: the list is read again after each (a note written through a command is not reported, but its turn ends in one of these). */
const NOTE_EVENTS = ["memory.written", "task.completed", "task.failed", "message.assistant"];

/**
 * The Dot's memory notes, read only: a list of what it wrote, newest first, with a search by name, and a reader
 * for the one that is open. The notes are the Dot's own; changing one is not offered here. A note the Dot writes
 * while the page is open is marked, and shown as a chip that leads to it.
 */
export function NotesTab({ dotId, open }: { dotId: string; open: string | null }) {
  const listing = useResource(() => loadNotes((path) => api.listFiles(dotId, path)), `notes:${dotId}`);
  useLiveRefresh(listing.reload, NOTE_EVENTS);
  const [query, setQuery] = useState("");
  // The notes written since the page opened, in order, and what each was.
  const [fresh, setFresh] = useState<Array<{ key: string; change: NoteChange }>>([]);
  // The keys of the list as last read: what tells a note the Dot has just written from one it has rewritten.
  const known = useRef<ReadonlySet<string>>(new Set());
  const notes = listing.data?.notes;
  useEffect(() => {
    known.current = new Set(notes?.map((note) => note.key));
  }, [notes]);
  useLiveEvents((event) => {
    const key = writtenKey(event.data);
    if (key === null) return;
    setFresh((current) => [{ key, change: changeOf(key, known.current) }, ...current.filter((item) => item.key !== key)]);
  }, ["memory.written"]);

  const failure = listing.error;
  if (isComputerStopped(failure)) return <ComputerOff dotId={dotId} state="STOPPED" what="Start the computer to read its notes" />;

  const all = listing.data?.notes ?? [];
  const shown = filterNotes(all, query);
  const selected = open === null ? null : (all.find((note) => note.key === open) ?? null);
  const freshKeys = new Set(fresh.map((item) => item.key));
  const chips: MemoryChip[] = fresh.map((item) => ({ id: item.key, text: item.key, href: memoryHref(dotId, { note: item.key }), change: item.change }));

  return (
    <div className="space-y-4">
      {chips.length > 0 ? <MemoryChips chips={chips} /> : null}
      <ErrorAlert error={failure} title="Could not read the notes" />

      <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className={cn("space-y-3", open !== null && "hidden md:block")}>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" aria-label="Search notes by name" placeholder="Search by name" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" />
            </div>
            <Button type="button" variant="outline" size="icon" onClick={listing.reload} disabled={listing.loading} aria-label="Refresh the notes">
              <RefreshCwIcon className={cn(listing.loading && "animate-spin motion-reduce:animate-none")} />
            </Button>
          </div>

          {listing.data === undefined && !failure ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : null}

          {listing.data !== undefined && all.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">The Dot has not written a note yet. The notes it keeps for later show here, newest first.</p>
          ) : null}
          {all.length > 0 && shown.length === 0 ? (
            <p role="status" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No note has "{query.trim()}" in its name.
            </p>
          ) : null}
          {shown.length > 0 ? (
            <ul aria-label="Notes" className="divide-y overflow-hidden rounded-lg border">
              {shown.map((note) => (
                <NoteRow key={note.key} dotId={dotId} note={note} current={note.key === selected?.key} fresh={freshKeys.has(note.key)} />
              ))}
            </ul>
          ) : null}
          {listing.data?.cut ? <p className="text-xs text-muted-foreground">The memory folder has more folders than are listed here. Open the Files view to see the rest.</p> : null}
        </div>

        <div className={cn("min-w-0", open === null && "hidden md:block")}>
          {open !== null ? (
            <Link href={memoryHref(dotId)} className="mb-3 inline-block text-sm text-muted-foreground hover:text-foreground hover:underline md:hidden">
              All notes
            </Link>
          ) : null}
          {selected !== null ? (
            <FilePreview key={`${selected.key}`} dotId={dotId} folder={noteFolderPath(selected)} entry={noteEntry(selected)} markdown={isMarkdown(selected.name)} />
          ) : open !== null && listing.data !== undefined ? (
            <p role="status" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {listing.data.cut
                ? `${open} is not among the notes listed. The memory folder has more folders than are listed, so it may be in one of them: the Files view shows them all.`
                : `There is no note called ${open} (any more).`}
            </p>
          ) : open === null ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Pick a note to read it.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NoteRow({ dotId, note, current, fresh }: { dotId: string; note: Note; current: boolean; fresh: boolean }) {
  return (
    <li className={cn("bg-card", current && "bg-accent", fresh && !current && "bg-info-soft")}>
      <Link href={memoryHref(dotId, { note: note.key })} aria-current={current ? "true" : undefined} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden">
        <FileTextIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block break-all">
            {note.folder === "" ? null : <span className="text-muted-foreground">{note.folder}/</span>}
            {note.name}
          </span>
          <span className="block text-xs text-muted-foreground">
            Written <time dateTime={note.mtime} title={formatDate(note.mtime)}>{relativeTime(note.mtime)}</time> · {formatBytes(note.size)}
          </span>
        </span>
      </Link>
    </li>
  );
}
