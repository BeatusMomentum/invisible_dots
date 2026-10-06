"use client";

import { MAX_HOST_FILE_BYTES, type FileEntry } from "@invisible-dots/shared/browser";
import { DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { canDownload, childPath, previewPlan } from "../../lib/files";
import { formatBytes } from "../../lib/format";
import { saveFile } from "../../lib/save-file";
import { ErrorAlert } from "../ErrorAlert";
import { Markdown } from "../markdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

type Loaded = { kind: "text"; text: string } | { kind: "binary" } | { kind: "image"; url: string };

/** Whether bytes that a name calls text are, in fact, not: a NUL byte does not occur in text. */
function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/** Save a file of the Dot's computer to the person's disk: read through the API, then handed to the browser as a download. */
async function download(dotId: string, folder: string, name: string): Promise<void> {
  saveFile(name, await api.readFile(dotId, childPath(folder, name)), "application/octet-stream");
}

/**
 * One file of the Dot's computer: its text, or its picture, and a button that saves it. Only what a page may safely
 * show is shown (`fileType` says which: images a page draws, text including markup and script as plain text), and a
 * file too big for a glance, or of another kind, is offered as a download alone. Nothing here can change the file.
 * `markdown` shows a text file as Markdown (the Dot's memory notes are written in it) instead of as it is written.
 */
export function FilePreview({ dotId, folder, entry, markdown = false }: { dotId: string; folder: string; entry: FileEntry; markdown?: boolean }) {
  const plan = previewPlan(entry);
  const downloadable = canDownload(entry);
  const path = childPath(folder, entry.name);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  useEffect(() => {
    if (plan.show === "none") return;
    let live = true;
    let url: string | null = null;
    setLoaded(null);
    setError(null);
    api
      .readFile(dotId, path)
      .then((bytes) => {
        if (!live) return;
        if (plan.show === "image") {
          url = URL.createObjectURL(new Blob([bytes], { type: plan.contentType }));
          setLoaded({ kind: "image", url });
        } else {
          setLoaded(looksBinary(bytes) ? { kind: "binary" } : { kind: "text", text: new TextDecoder().decode(bytes) });
        }
      })
      .catch((failure: unknown) => {
        if (live) setError(failure);
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
    // The entry's size and mtime are part of what was listed: a file that changed is read again.
  }, [dotId, path, plan.show, entry.size, entry.mtime]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await download(dotId, folder, entry.name);
    } catch (failure) {
      setSaveError(failure);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label={`File ${entry.name}`} className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-medium" title={path}>
          {entry.name}
        </h3>
        <span className="text-xs text-muted-foreground">{formatBytes(entry.size)}</span>
        {downloadable ? (
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void save()}>
            <DownloadIcon />
            {saving ? "Downloading..." : "Download"}
          </Button>
        ) : null}
      </div>
      <ErrorAlert error={saveError} title="The file was not downloaded" />

      {!downloadable ? (
        <p className="text-sm text-muted-foreground">This file is too big to be handed out ({formatBytes(entry.size)}, the limit is {formatBytes(MAX_HOST_FILE_BYTES)}). Read it on the computer itself, or copy it in parts.</p>
      ) : plan.show === "none" ? (
        <p className="text-sm text-muted-foreground">
          {plan.reason === "too-large" ? `This file is too big to show here (${formatBytes(entry.size)}). Download it to read it.` : "This kind of file is not shown here. Download it to open it."}
        </p>
      ) : error ? (
        <ErrorAlert error={error} title="Could not read the file" />
      ) : loaded === null ? (
        <Skeleton className="h-32 w-full" aria-busy="true" />
      ) : loaded.kind === "image" ? (
        // A plain img: the source is an object URL of the bytes the API returned, which next/image cannot load.
        <img src={loaded.url} alt={`The picture ${entry.name}`} className="max-h-[32rem] max-w-full rounded-md border" />
      ) : loaded.kind === "binary" ? (
        <p className="text-sm text-muted-foreground">This file is not text, whatever its name says. Download it to open it.</p>
      ) : loaded.text === "" ? (
        <p className="text-sm text-muted-foreground">The file is empty.</p>
      ) : markdown ? (
        <div tabIndex={0} aria-label={`Contents of ${entry.name}`} className="max-h-[32rem] overflow-auto">
          <Markdown>{loaded.text}</Markdown>
        </div>
      ) : (
        <pre tabIndex={0} aria-label={`Contents of ${entry.name}`} className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">
          {loaded.text}
        </pre>
      )}
    </section>
  );
}
