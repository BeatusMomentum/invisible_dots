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
