/**
 * Split `text` into pieces of at most `max` characters, in order, so that joining them with the
 * separators that were cut reads the same. A piece ends at the last blank line, else the last line
 * break, else the last space inside the limit, and only a word longer than the limit is cut.
 * Whitespace at a cut is dropped; nothing else is changed.
 */
export function splitText(text: string, max: number): string[] {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < max / 2) {
      cut = max;
      // Never leave half of a surrogate pair at the end of a piece.
      if (cut > 1 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut--;
    }
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
