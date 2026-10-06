import { defineConfig, devices } from "@playwright/test";

/**
 * The browser tests of the web client. Each worker starts its own control plane and web server (e2e/harness.ts), so
 * nothing here needs a server running beforehand, only `next build`. One worker: the specs share that one server and
 * make their own Dots, named for the test.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // CI reads the JUnit report: .github/scripts/test-guard.mjs counts what ran against the floors file.
  reporter: process.env.CI ? [["list"], ["junit", { outputFile: "playwright-report.xml" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
