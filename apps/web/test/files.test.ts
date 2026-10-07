import { MAX_HOST_FILE_BYTES, type FileEntry } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { breadcrumbs, canDownload, childPath, IMAGE_PREVIEW_MAX_BYTES, previewPlan, sortEntries, TEXT_PREVIEW_MAX_BYTES } from "../src/lib/files";

const entry = (name: string, type: FileEntry["type"] = "file", size = 10): FileEntry => ({ name, type, size, mtime: "2026-03-10T12:00:00Z" });

describe("the folders above a path", () => {
  it("start at Home and name each folder down to the one listed", () => {
    expect(breadcrumbs("/home/dot")).toEqual([{ name: "Home", path: "/home/dot" }]);
    expect(breadcrumbs("/home/dot/memory/trips")).toEqual([
      { name: "Home", path: "/home/dot" },
      { name: "memory", path: "/home/dot/memory" },
      { name: "trips", path: "/home/dot/memory/trips" },
    ]);
  });

  it("do not pretend a path outside home is under it", () => {
    expect(breadcrumbs("/home/dotty/x")).toEqual([
      { name: "home", path: "/home" },
      { name: "dotty", path: "/home/dotty" },
      { name: "x", path: "/home/dotty/x" },
    ]);
  });

  it("join a name onto a folder with one slash", () => {
    expect(childPath("/home/dot", "a.txt")).toBe("/home/dot/a.txt");
    expect(childPath("/home/dot/memory/", "a.txt")).toBe("/home/dot/memory/a.txt");
  });
});

describe("the order a folder is listed in", () => {
  it("puts folders first, then files, each by name without regard to case, and does not change what it was given", () => {
    const given = [entry("b.txt"), entry("Zeta", "dir"), entry("A.txt"), entry("alpha", "dir"), entry("socket", "other")];
    const sorted = sortEntries(given);
    expect(sorted.map((e) => e.name)).toEqual(["alpha", "Zeta", "A.txt", "b.txt", "socket"]);
    expect(given.map((e) => e.name)).toEqual(["b.txt", "Zeta", "A.txt", "alpha", "socket"]);
  });

  it("gives names that differ only in case the same order whichever came first", () => {
    expect(sortEntries([entry("a"), entry("A")]).map((e) => e.name)).toEqual(sortEntries([entry("A"), entry("a")]).map((e) => e.name));
  });
});

describe("how a file is shown", () => {
  it("shows text as text and an image as its type, whatever the case of the name", () => {
    expect(previewPlan(entry("fares.md"))).toEqual({ show: "text", contentType: "text/plain; charset=utf-8" });
    expect(previewPlan(entry("SHOT.PNG"))).toEqual({ show: "image", contentType: "image/png" });
  });

  it("never draws markup: an svg is text", () => {
    expect(previewPlan(entry("logo.svg")).show).toBe("text");
    expect(previewPlan(entry("page.html")).show).toBe("text");
  });

  it("offers a download only up to what the control plane hands out", () => {
    expect(canDownload({ size: MAX_HOST_FILE_BYTES })).toBe(true);
    expect(canDownload({ size: MAX_HOST_FILE_BYTES + 1 })).toBe(false);
  });

  it("offers a download alone for every other kind", () => {
    expect(previewPlan(entry("archive.zip"))).toEqual({ show: "none", reason: "download-only" });
    expect(previewPlan(entry("Makefile"))).toEqual({ show: "none", reason: "download-only" });
  });

  it("does not read a file too big for a glance, at the limit of its kind and not before", () => {
    expect(previewPlan(entry("a.txt", "file", TEXT_PREVIEW_MAX_BYTES)).show).toBe("text");
    expect(previewPlan(entry("a.txt", "file", TEXT_PREVIEW_MAX_BYTES + 1))).toEqual({ show: "none", reason: "too-large" });
    expect(previewPlan(entry("a.png", "file", IMAGE_PREVIEW_MAX_BYTES)).show).toBe("image");
    expect(previewPlan(entry("a.png", "file", IMAGE_PREVIEW_MAX_BYTES + 1))).toEqual({ show: "none", reason: "too-large" });
  });
});
