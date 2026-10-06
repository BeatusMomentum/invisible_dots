import { ApiError } from "@invisible-dots/sdk";
import type { FileEntry, FilesListAnswer } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { changeOf, filterNotes, isMarkdown, loadNotes, MAX_NOTE_DEPTH, MAX_NOTE_FOLDERS, noteEntry, noteFolderPath, writtenKey, type Note } from "../src/lib/notes";

const file = (name: string, mtime = "2026-03-10T12:00:00Z", size = 10): FileEntry => ({ name, type: "file", size, mtime });
const dir = (name: string): FileEntry => ({ name, type: "dir", size: 0, mtime: "2026-03-10T12:00:00Z" });

/** A computer whose folders are given by absolute path; a folder that is not in the table is not there (404). */
function computer(folders: Record<string, FileEntry[]>) {
  const asked: string[] = [];
  const list = async (path: string): Promise<FilesListAnswer> => {
    asked.push(path);
    const entries = folders[path];
    if (entries === undefined) throw new ApiError(404, "not_found", `no such folder ${path}`);
    return { path, entries };
  };
  return { list, asked };
}

describe("finding the notes", () => {
  it("lists the memory folder and the folders in it, and keys each note by its path under memory", async () => {
    const { list } = computer({
      "/home/dot/memory": [file("fares.md", "2026-03-10T10:00:00Z"), dir("trips")],
      "/home/dot/memory/trips": [file("rome.md", "2026-03-10T11:00:00Z"), dir("2026")],
      "/home/dot/memory/trips/2026": [file("may.md", "2026-03-10T12:00:00Z")],
    });
    const { notes, cut } = await loadNotes(list);
    expect(cut).toBe(false);
    expect(notes.map((n) => [n.key, n.name, n.folder])).toEqual([
      ["trips/2026/may.md", "may.md", "trips/2026"],
      ["trips/rome.md", "rome.md", "trips"],
      ["fares.md", "fares.md", ""],
    ]);
  });

  it("puts the newest written first, and the same moment in the order of the names", async () => {
    const { list } = computer({ "/home/dot/memory": [file("b.md", "2026-03-10T10:00:00Z"), file("a.md", "2026-03-10T10:00:00Z"), file("c.md", "2026-03-11T10:00:00Z")] });
    expect((await loadNotes(list)).notes.map((n) => n.key)).toEqual(["c.md", "a.md", "b.md"]);
  });

  it("is an empty list, not a failure, while the Dot has written no note (the folder is not there)", async () => {
    expect(await loadNotes(computer({}).list)).toEqual({ notes: [], cut: false });
  });

  it("leaves out what is not a file or a folder (a link could lead anywhere, and a loop)", async () => {
    const { list, asked } = computer({ "/home/dot/memory": [file("a.md"), { name: "link", type: "other", size: 0, mtime: "2026-03-10T12:00:00Z" }] });
    expect((await loadNotes(list)).notes.map((n) => n.key)).toEqual(["a.md"]);
    expect(asked).toEqual(["/home/dot/memory"]);
  });

  it("skips a folder that vanished while it was being walked", async () => {
    const { list } = computer({ "/home/dot/memory": [file("a.md"), dir("gone")] });
    expect((await loadNotes(list)).notes.map((n) => n.key)).toEqual(["a.md"]);
  });

  it("fails on an answer it cannot do anything with, rather than showing a partial list as the whole", async () => {
    const list = async (): Promise<FilesListAnswer> => {
      throw new ApiError(502, "guest_unreachable", "the guest did not answer");
    };
    await expect(loadNotes(list)).rejects.toMatchObject({ code: "guest_unreachable" });
  });

  it("walks no deeper than the limit and says it was cut", async () => {
    const folders: Record<string, FileEntry[]> = {};
    let path = "/home/dot/memory";
    for (let level = 0; level <= MAX_NOTE_DEPTH + 1; level++) {
      folders[path] = [file(`n${level}.md`), dir("d")];
      path += "/d";
    }
    folders[path] = [file("too-deep.md")];
    const { notes, cut } = await loadNotes(computer(folders).list);
    expect(cut).toBe(true);
    expect(notes).toHaveLength(MAX_NOTE_DEPTH + 1);
    expect(notes.some((n) => n.name === "too-deep.md")).toBe(false);
  });

  it("lists no more folders than the limit and says it was cut", async () => {
    const root: FileEntry[] = [];
    const folders: Record<string, FileEntry[]> = { "/home/dot/memory": root };
    for (let i = 0; i < MAX_NOTE_FOLDERS + 5; i++) {
      root.push(dir(`f${i}`));
      folders[`/home/dot/memory/f${i}`] = [file(`n${i}.md`)];
    }
    const { list, asked } = computer(folders);
    const { notes, cut } = await loadNotes(list);
    expect(cut).toBe(true);
    expect(asked).toHaveLength(MAX_NOTE_FOLDERS);
    expect(notes).toHaveLength(MAX_NOTE_FOLDERS - 1);
  });

  it("is not cut when the notes just fit the limits", async () => {
    const root: FileEntry[] = [];
    const folders: Record<string, FileEntry[]> = { "/home/dot/memory": root };
    for (let i = 0; i < MAX_NOTE_FOLDERS - 1; i++) {
      root.push(dir(`f${i}`));
      folders[`/home/dot/memory/f${i}`] = [file(`n${i}.md`)];
    }
    expect((await loadNotes(computer(folders).list)).cut).toBe(false);
  });
});

describe("one note", () => {
  const note: Note = { key: "trips/rome.md", name: "rome.md", folder: "trips", size: 12, mtime: "2026-03-10T12:00:00Z" };

  it("knows the folder it is in and the file entry the preview takes", () => {
    expect(noteFolderPath(note)).toBe("/home/dot/memory/trips");
    expect(noteFolderPath({ folder: "" })).toBe("/home/dot/memory");
    expect(noteEntry(note)).toEqual({ name: "rome.md", type: "file", size: 12, mtime: "2026-03-10T12:00:00Z" });
  });

  it("is read as Markdown when its name says so", () => {
    expect(isMarkdown("rome.md")).toBe(true);
    expect(isMarkdown("ROME.MD")).toBe(true);
    expect(isMarkdown("rome.markdown")).toBe(true);
    expect(isMarkdown("rome.txt")).toBe(false);
    expect(isMarkdown("md")).toBe(false);
  });
});

describe("searching by name", () => {
  const notes = ["trips/rome.md", "fares.md", "Trips/Lisbon.md"].map((key): Note => ({ key, name: key.split("/").pop()!, folder: "", size: 1, mtime: "2026-03-10T12:00:00Z" }));

  it("matches the path whatever its case", () => {
    expect(filterNotes(notes, "trips").map((n) => n.key)).toEqual(["trips/rome.md", "Trips/Lisbon.md"]);
    expect(filterNotes(notes, "  FARES ").map((n) => n.key)).toEqual(["fares.md"]);
  });

  it("shows every note for a blank search, as a copy", () => {
    const all = filterNotes(notes, "   ");
    expect(all).toEqual(notes);
    expect(all).not.toBe(notes);
  });

  it("finds none when none matches", () => {
    expect(filterNotes(notes, "nowhere")).toEqual([]);
  });
});

describe("a note the Dot has just written", () => {
  it("is read off the event: its key", () => {
    expect(writtenKey({ key: "trips/rome.md" })).toBe("trips/rome.md");
    expect(writtenKey({ key: "" })).toBeNull();
    expect(writtenKey({ key: 3 })).toBeNull();
    expect(writtenKey({})).toBeNull();
  });

  it("is added when the list had none by that name, updated when it did", () => {
    const known = new Set(["fares.md"]);
    expect(changeOf("fares.md", known)).toBe("updated");
    expect(changeOf("new.md", known)).toBe("added");
  });
});
