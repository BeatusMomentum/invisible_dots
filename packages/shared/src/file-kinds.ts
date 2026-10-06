/**
 * What a file of a Dot's computer is, by its name: an image, text, or neither. The bytes are the Dot's own, written
 * by a model that may have read hostile text, so one table decides for both readers of a file: the API serves it
 * under the type this gives (images as images, text, markup and script included, as `text/plain`, the rest as a
 * download), and the web client previews only what this calls an image or text.
 */
export type FileKind = "image" | "text" | "other";

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

export interface FileType {
  kind: FileKind;
  /** The type a browser is told: an image type, `text/plain; charset=utf-8`, or `application/octet-stream`. */
  contentType: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The kind and type of the file called `name` (a bare name or a path: only what follows the last slash counts). */
export function fileType(name: string): FileType {
  const extension = extensionOf(name.slice(name.lastIndexOf("/") + 1));
  const image = IMAGES[extension];
  if (image !== undefined) return { kind: "image", contentType: image };
  if (TEXT.has(extension)) return { kind: "text", contentType: "text/plain; charset=utf-8" };
  return { kind: "other", contentType: "application/octet-stream" };
}
