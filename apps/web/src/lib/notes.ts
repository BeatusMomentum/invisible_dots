/**
 * The Dot's memory notes as the Memory view needs them. A note is a file under `/home/dot/memory` that the Dot
 * wrote itself (the engine reports one as `memory.written` with its path relative to that folder, `trips/rome.md`),
 * so the list is the folder's files, found by listing it the way the Files view does: there is no notes route. The
 * folder may hold folders, so the list walks down, with a bound that is said when it cuts the walk short.
 */
import { ApiError } from "@invisible-dots/sdk";
import { GUEST_PATHS, type FileEntry, type FilesListAnswer } from "@invisible-dots/shared/browser";
import { childPath } from "./files";

/** The most folders one walk lists, the memory folder included: each is one request to the Dot's computer. */
export const MAX_NOTE_FOLDERS = 40;
/** How deep the walk goes below the memory folder. */
export const MAX_NOTE_DEPTH = 4;

export interface Note {
  /** The path relative to the memory folder: what `memory.written` calls the key. */
  key: string;
  /** The file's own name. */
  name: string;
  /** The folder it is in, relative to the memory folder; empty for the memory folder itself. */
  folder: string;
  size: number;
  mtime: string;
}

export interface NoteList {
  /** Newest written first. */
  notes: Note[];
  /** The walk stopped at a limit: there are folders it did not list. */
  cut: boolean;
}

/** The absolute path of the folder that holds `note`. */
export function noteFolderPath(note: Pick<Note, "folder">): string {
  return note.folder === "" ? GUEST_PATHS.memory : childPath(GUEST_PATHS.memory, note.folder);
}

/** The file entry the file preview takes for `note`. */
export function noteEntry(note: Note): FileEntry {
  return { name: note.name, type: "file", size: note.size, mtime: note.mtime };
}

function byNewest(a: Note, b: Note): number {
  return Date.parse(b.mtime) - Date.parse(a.mtime) || a.key.localeCompare(b.key);
}

/** A folder that is not there (the Dot has written no note yet, or removed the folder since): nothing to list, not a failure. */
function isMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "not_found" || error.code === "not_a_directory");
}

/**
 * Every note, found by listing the memory folder and the folders in it, level by level. A folder is listed once the
 * limits allow; what they leave out is reported as `cut` so the view can say so. The memory folder itself being
 * absent is an empty list: it is created by the first note.
 */
export async function loadNotes(list: (path: string) => Promise<FilesListAnswer>): Promise<NoteList> {
  const notes: Note[] = [];
  let listed = 0;
  let cut = false;
  let level: string[] = [""];
  for (let depth = 0; level.length > 0; depth++) {
    const room = MAX_NOTE_FOLDERS - listed;
    if (level.length > room) cut = true;
    const folders = level.slice(0, Math.max(0, room));
    listed += folders.length;
    const answers = await Promise.all(
      folders.map(async (folder) => {
        try {
          return await list(folder === "" ? GUEST_PATHS.memory : childPath(GUEST_PATHS.memory, folder));
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }
      }),
    );
    const next: string[] = [];
    answers.forEach((answer, index) => {
      const folder = folders[index]!;
      for (const entry of answer?.entries ?? []) {
        const key = folder === "" ? entry.name : `${folder}/${entry.name}`;
        if (entry.type === "file") notes.push({ key, name: entry.name, folder, size: entry.size, mtime: entry.mtime });
        else if (entry.type === "dir") {
          if (depth + 1 > MAX_NOTE_DEPTH) cut = true;
          else next.push(key);
        }
      }
    });
    level = next;
  }
  return { notes: notes.sort(byNewest), cut };
}

/** The notes whose path holds `query`, whatever its case; all of them for a blank query. */
export function filterNotes(notes: readonly Note[], query: string): Note[] {
  const needle = query.trim().toLowerCase();
  return needle === "" ? [...notes] : notes.filter((note) => note.key.toLowerCase().includes(needle));
}

/** The key a `memory.written` event reports, or null when it carries none. */
export function writtenKey(data: Record<string, unknown>): string | null {
  return typeof data.key === "string" && data.key !== "" ? data.key : null;
}

export type NoteChange = "added" | "updated";

/**
 * What a note written while the page is open is: added when the list had no such note, updated when it did. The
 * engine's event says only that a file was written; the list is what tells the two apart.
 */
export function changeOf(key: string, known: ReadonlySet<string>): NoteChange {
  return known.has(key) ? "updated" : "added";
}

/** Whether a note is shown as Markdown: the Dot writes its notes in it, and a `.md` or `.markdown` file is read that way. */
export function isMarkdown(name: string): boolean {
  return /\.(?:md|markdown)$/i.test(name);
}
