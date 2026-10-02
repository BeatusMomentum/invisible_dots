import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The npm workspace root: dependencies are hoisted there, and the shared
// package is linked from there as TypeScript source.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
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
