import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/{src,test}/**/*.test.ts",
      "packages/*/{src,test}/**/*.test.ts",
      "guest/image-builder/{src,test}/**/*.test.ts",
      // Checks over the whole repository, such as the platform branches of section 1.1.
      "tests/repo/**/*.test.ts",
    ],
    // The web client's tests need no DOM: they run here with everything else.
    // invisible_engine_dots/ holds the nanobot fork: Python, with its own pytest suite
    // (the engine job of the CI workflow); nothing of it runs here.
    exclude: ["**/node_modules/**", "**/.next/**", "invisible_engine_dots/**"],
    environment: "node",
    // Setup hooks boot an embedded PostgreSQL (PGlite, WebAssembly) and run
    // the migrations, or start servers and child processes. On a loaded
    // machine that takes longer than vitest's default 10 s without anything
    // being wrong (measured: the API suite's setup timed out in a container
    // running the whole suite in parallel), so it gets one allowance here
    // instead of one per file.
    hookTimeout: 60_000,
    // The same for a test: one that starts servers or child processes can
    // stall for seconds under heavy disk contention without anything being
    // wrong. A test that waits on a condition fails on a code fault only,
    // never on the machine's speed.
    testTimeout: 30_000,
  },
});
