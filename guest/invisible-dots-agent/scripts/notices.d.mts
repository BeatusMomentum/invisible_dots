/** The text of THIRD_PARTY_NOTICES.txt for a bundle, from esbuild's metafile. */
export function thirdPartyNotices(options: { metafile: { inputs: Record<string, unknown> }; workingDir: string; repoRoot: string }): string;

/** Where the notices go: next to the bundle. */
export function noticesPath(bundle: string): string;
