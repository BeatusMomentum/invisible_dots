// Derived from OpenDots (Shashankss1205) opendots/web/app.js at bb8db95, MIT; changed: the kinds of line (heading, added, removed, context) are kept, but a line's kind comes from how the preview is built (the old text of an edit is removed lines, its new text added lines) and not from the character it starts with, so a removed line that begins with dashes or an added one with plus signs is not taken for a heading; unchanged lines at either end are trimmed to a little context.

/** How a line of a preview is drawn. */
export type DiffKind = "heading" | "add" | "remove" | "context";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Unchanged lines kept on each side of a change. */
export const DIFF_CONTEXT = 2;

/** The lines of a text: none for an empty text, and a final line break does not make an empty last line. */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Every line of `content` as added: what writing a whole file does (the file's earlier content, if any, is not known here). */
export function additionDiff(content: string): DiffLine[] {
  return linesOf(content).map((text) => ({ kind: "add", text }));
}

/**
 * What replacing `before` with `after` does: the lines both texts share at the start and the end are context (at most
 * DIFF_CONTEXT of each), the lines between them are removed from `before` and added from `after`.
 */
export function replacementDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const lines: DiffLine[] = [];
  for (const text of a.slice(Math.max(0, start - DIFF_CONTEXT), start)) lines.push({ kind: "context", text });
  for (const text of a.slice(start, a.length - end)) lines.push({ kind: "remove", text });
  for (const text of b.slice(start, b.length - end)) lines.push({ kind: "add", text });
  for (const text of a.slice(a.length - end, a.length - end + DIFF_CONTEXT)) lines.push({ kind: "context", text });
  return lines;
}

/** How many lines a diff adds and removes. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
  };
}
