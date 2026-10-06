/** A Dot's face: no asset, a gradient taken from a hash of its id and the first letter of its name. */

/** FNV-1a over the UTF-16 code units: small, stable across runs and platforms, and spreads similar ids apart. */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export interface Avatar {
  initial: string;
  /** A CSS `background` value. */
  background: string;
}

/**
 * The lightness of the two ends of the gradient, low enough for the white letter to read at WCAG AA (4.5 to 1) on every
 * hue: at 60 percent saturation the yellows are the lightest, and 28 percent keeps them just above the line.
 */
const LIGHTNESS = { from: 28, to: 22 } as const;

export function avatarOf(id: string, name: string): Avatar {
  const hash = hash32(id);
  const from = hash % 360;
  const to = (from + 40 + ((hash >>> 9) % 50)) % 360;
  const first = [...name.trim()][0];
  return {
    initial: first ? first.toLocaleUpperCase() : "?",
    background: `linear-gradient(135deg, hsl(${from} 60% ${LIGHTNESS.from}%), hsl(${to} 60% ${LIGHTNESS.to}%))`,
  };
}
