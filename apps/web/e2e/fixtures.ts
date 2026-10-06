import { test as base, type Page } from "@playwright/test";
import { startHarness, type Harness } from "./harness.js";

interface Fixtures {
  /** Signed in: the page already holds the session cookie. */
  signedIn: Page;
}

export const test = base.extend<Fixtures, { harness: Harness }>({
  // One control plane and one web server per worker.
  harness: [
    async ({}, use) => {
      const harness = await startHarness();
      try {
        await use(harness);
      } finally {
        await harness.close();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],
  signedIn: async ({ page, harness }, use) => {
    const response = await page.request.post(`${harness.webUrl}/session`, { data: { token: harness.token } });
    if (!response.ok()) throw new Error(`sign-in failed: ${response.status()}`);
    await use(page);
  },
});

export { expect } from "@playwright/test";
