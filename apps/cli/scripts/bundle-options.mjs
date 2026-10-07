// The esbuild options of the invisible-dots bundle, shared by scripts/build.mjs and tests/repo/cli-bundle.test.ts,
// which bundles a real Telegram call with them: what breaks only once bundled is caught there, not by a person.
export const BUNDLE_OPTIONS = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  // Classes and functions keep their names. esbuild renames one whose name another module also uses (AbortSignal
  // became AbortSignal2), and node-fetch, under grammY, recognizes a signal by its constructor's name: renamed, every
  // Telegram call failed as "Network request for 'getMe' failed!", in the bundle only.
  keepNames: true,
  // pg loads its optional native binding with require(); it is never installed here.
  // The opt-in WhatsApp client (Baileys, which depends on libsignal, GPL-3.0) is not in the bundle either: the adapter
  // loads it at run time from optional/whatsapp/ by path (packages/channels/src/whatsapp-baileys/client.ts), so no
  // import of it is in the bundle's graph, and a bundle that held it would be a GPL work.
  external: ["pg-native"],
  banner: {
    // CommonJS dependencies inside an ESM bundle still call require().
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
};
