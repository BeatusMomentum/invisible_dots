/**
 * The favicon: the brand's dot, with a second dot in the corner while something needs the person. A favicon cannot
 * read CSS variables, so the two colors are written here as the `--primary` and `--attention` values of tokens.css;
 * test/tokens.test.ts fails when they drift apart.
 */
export const FAVICON_PRIMARY = "#161615";
export const FAVICON_ATTENTION = "#a85a00";

export function faviconHref(needsYou: boolean): string {
  const badge = needsYou ? `<circle cx="24" cy="8" r="7" fill="${FAVICON_ATTENTION}" stroke="#ffffff" stroke-width="2"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="15" cy="17" r="12" fill="${FAVICON_PRIMARY}"/>${badge}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
