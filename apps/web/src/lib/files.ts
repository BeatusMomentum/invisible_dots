/**
 * What the Files view needs to know about a folder of the Dot's computer: where it is, how to go up, in what order
 * to list it and which of its files can be shown. Paths are the guest's, POSIX, under home; the API has already
 * resolved them (`GET .../files/list` answers the path it listed), so none of this validates one.
 */
import { fileType, GUEST_PATHS, type FileEntry } from "@invisible-dots/shared/browser";

/** A text file bigger than this is not read for a preview: the whole file crosses the wire, and a page of this size is no longer a glance. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** An image bigger than this is not drawn, for the same reason. */
export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

export interface Crumb {
  name: string;
  /** The absolute path of this folder. */
  path: string;
}

/** The folders from home down to `path`: `Home` first, then each segment under it. A path outside home gets only its own segments. */
export function breadcrumbs(path: string): Crumb[] {
  const home = GUEST_PATHS.home;
  const inside = path === home || path.startsWith(`${home}/`);
  const crumbs: Crumb[] = inside ? [{ name: "Home", path: home }] : [];
  const rest = (inside ? path.slice(home.length) : path).split("/").filter(Boolean);
  let current = inside ? home : "";
  for (const segment of rest) {
    current = `${current}/${segment}`;
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}

/** The path of an entry of the folder `folder`. */
export function childPath(folder: string, name: string): string {
  return `${folder.replace(/\/+$/, "")}/${name}`;
}

/** Folders first, then files, each group by name without regard to case: the order a file manager lists in. */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  const rank = (entry: FileEntry) => (entry.type === "dir" ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));
}

export type PreviewPlan = { show: "text" | "image"; contentType: string } | { show: "none"; reason: "download-only" | "too-large" };

/** How to show a file: as text, as an image, or not at all (a kind a page does not draw, or a file too big for a glance). */
export function previewPlan(entry: Pick<FileEntry, "name" | "size">): PreviewPlan {
  const { kind, contentType } = fileType(entry.name);
  if (kind === "other") return { show: "none", reason: "download-only" };
  if (entry.size > (kind === "text" ? TEXT_PREVIEW_MAX_BYTES : IMAGE_PREVIEW_MAX_BYTES)) return { show: "none", reason: "too-large" };
  return { show: kind, contentType };
}
