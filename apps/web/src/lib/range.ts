// Derived from assistant-ui packages/ui/src/components/react/assistant-ui/utils/range.ts at 0bdf050, MIT; changed: only `clamp` and `take`, the two this app uses (the diff preview's line cap), are kept.

/**
 * Constrains a value to `min…max`. NaN is decided first and maps to `min`.
 * For any other value, an empty collection can invert the bounds and `max`
 * wins there: `clamp(3, 1, 0)` is `0`, which is what lets a floor of one item
 * still yield none.
 */
export function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** The first `count` items, for a `count` that may be out of range. */
export function take<T>(items: readonly T[], count: number) {
  return items.slice(0, Math.floor(clamp(count, 0, items.length)));
}
