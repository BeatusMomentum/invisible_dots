import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/{src,test}/**/*.test.ts",
      "packages/*/{src,test}/**/*.test.ts",
      "guest/invisible-dots-agent/{src,test}/**/*.test.ts",
      "guest/image-builder/{src,test}/**/*.test.ts",
      "guest-runtime/*/{src,test}/**/*.test.ts",
      // Checks over the whole repository, such as the platform branches of section 1.1.
      "tests/repo/**/*.test.ts",
    ],
    // The web client's tests need no DOM: they run here with everything else.
    exclude: ["**/node_modules/**", "**/.next/**"],
    environment: "node",
    // Setup hooks boot an embedded PostgreSQL (PGlite, WebAssembly) and run
    // the migrations, or start servers and child processes. On a loaded
    // machine that takes longer than vitest's default 10 s without anything
    // being wrong (measured: the API suite's setup timed out in a container
    // running the whole suite in parallel), so it gets one allowance here
    // instead of one per file.
    hookTimeout: 60_000,
    // The same for a test: the guest runtime's tests commit to SQLite with
    // synchronous=FULL, as the guest does, and under heavy disk contention a
    // single fsync stalls the event loop for seconds (measured: a 150 ms test
    // ran 8 s in a container running the whole suite). A test that waits on
    // a condition fails on a code fault only, never on the machine's speed.
    testTimeout: 30_000,
  },
});
