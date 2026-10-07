import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// invisible_dots sends no telemetry, and nothing turns it on. Next's build and dev server create their telemetry
// after they load this file and read this variable first, ahead of any setting the person's own Next has stored, so
// every way of building the web client (setup, npm run build, next dev) sends nothing.
process.env.NEXT_TELEMETRY_DISABLED = "1";

// The npm workspace root: dependencies are hoisted there, and the shared
// package is linked from there as TypeScript source.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
  // `invisible-dots server` runs the built web client as a child process:
  // .next/standalone holds a server.js and the files it needs, no `next` CLI.
  output: "standalone",
  // The workspace packages publish their .ts sources, not compiled output.
  transpilePackages: ["@invisible-dots/shared", "@invisible-dots/sdk"],
  outputFileTracingRoot: workspaceRoot,
  poweredByHeader: false,
  reactStrictMode: true,
  // The shared package is written for NodeNext and imports "./config.js" for
  // config.ts. Turbopack only maps .js to .ts when the app's own tsconfig uses
  // NodeNext resolution, which Next's own imports ("next/navigation") do not
  // type-check under, so the build uses webpack with an extension alias.
  webpack(webpackConfig: { resolve?: { extensionAlias?: Record<string, string[]> } }) {
    webpackConfig.resolve ??= {};
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return webpackConfig;
  },
};

export default config;
