/**
 * How a file of a Dot's computer is served by `GET /api/dots/:id/files`. The bytes are the Dot's own, written
 * by a model that may have read hostile text, and the web server answers from the same origin as the page, so a
 * file is never given a type a browser would run: images are images, text (source and markup included) is
 * `text/plain`, and everything else is a download.
 */
import { fileType } from "@invisible-dots/shared";

export interface FileServing {
  contentType: string;
  /** The `Content-Disposition` header: `inline` for what a page may show, `attachment` for the rest. */
  disposition: string;
}

/** The type and disposition for the file at `path` (a guest path). */
export function serveFile(path: string): FileServing {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { kind, contentType } = fileType(name);
  // The plain filename is for old clients (printable ASCII, no quote, backslash or percent); filename* carries the real one.
  const plain = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return { contentType, disposition: `${kind === "other" ? "attachment" : "inline"}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}` };
}
