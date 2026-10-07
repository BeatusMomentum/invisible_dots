import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

describe("the Playwright config", () => {
  for (const ci of ["", "1"]) {
    it(`writes the JUnit report that test-guard reads, ${ci ? "under CI" : "outside CI"}, so a local run never leaves a stale one`, async () => {
      vi.stubEnv("CI", ci);
      vi.resetModules();
      const { default: config } = await import("../playwright.config");
      expect(config.reporter).toContainEqual(["junit", { outputFile: "playwright-report.xml" }]);
    });
  }
});

describe("the browser tests' harness", () => {
  it("runs the web client as the product does: the standalone server through the CLI's own start, not `next start` with the whole environment", () => {
    const harness = readFileSync(new URL("../e2e/harness.ts", import.meta.url), "utf8");
    expect(harness).toContain("startWebServer");
    expect(harness).toContain("locateWebBuild");
    expect(harness).not.toContain("next/dist/bin/next");
    expect(harness).not.toContain("...process.env, INVISIBLE_DOTS_HOME");
  });
});
