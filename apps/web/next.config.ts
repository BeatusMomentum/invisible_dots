import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

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
  // What every response says besides the pages' Content Security Policy (src/proxy.ts): the browser does not guess the type
  // of what it was sent (a Dot's file is served under its own, apps/api/src/file-types.ts), nothing is sent as a referrer, and
  // no page is framed (the policy's frame-ancestors says it too, for the browsers that read it, and this for the ones that do not).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
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
