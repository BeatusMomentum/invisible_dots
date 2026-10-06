/**
 * How a file of a Dot's computer is served by `GET /api/dots/:id/files`. The bytes are the Dot's own, written
 * by a model that may have read hostile text, and the web server answers from the same origin as the page, so a
 * file is never given a type a browser would run: images are images, text (source and markup included) is
 * `text/plain`, and everything else is a download.
 */
const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const TEXT = new Set([
  "txt", "md", "markdown", "log", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "csv", "tsv",
  "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "bash", "go", "rs", "c", "h", "cpp", "java", "rb", "sql",
  "html", "htm", "css", "xml", "svg",
]);

export interface FileServing {
  contentType: string;
  /** The `Content-Disposition` header: `inline` for what a page may show, `attachment` for the rest. */
  disposition: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The type and disposition for the file at `path` (a guest path). */
export function serveFile(path: string): FileServing {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const extension = extensionOf(name);
  const contentType = IMAGES[extension] ?? (TEXT.has(extension) ? "text/plain; charset=utf-8" : "application/octet-stream");
  const kind = contentType === "application/octet-stream" ? "attachment" : "inline";
  // The plain filename is for old clients (printable ASCII, no quote, backslash or percent); filename* carries the real one.
  const plain = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return { contentType, disposition: `${kind}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}` };
}
