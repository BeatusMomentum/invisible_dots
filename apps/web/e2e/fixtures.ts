import { test as base, type Page } from "@playwright/test";
import { startHarness, type Harness } from "./harness.js";

interface Fixtures {
  /** Signed in: the page already holds the session cookie. */
  signedIn: Page;
  /** The same, to the host of `unconfigured`. */
  signedInUnconfigured: Page;
  /** The same, to the host of `fresh`. */
  signedInFresh: Page;
}

interface WorkerFixtures {
  harness: Harness;
  /**
   * A control plane of its own that has never been given a key and has no Dot: the host a person finds on the first
   * run. Started only by a test that asks for it.
   */
  unconfigured: Harness;
  /**
   * A control plane of its own with a key and no Dot, for the pages that count what needs the person across every Dot
   * (the Inbox): on the shared one, the approvals, failures and errors of every other spec would be in the count.
   */
  fresh: Harness;
}

async function signIn(page: Page, harness: Harness): Promise<void> {
  const response = await page.request.post(`${harness.webUrl}/session`, { data: { token: harness.token } });
  if (!response.ok()) throw new Error(`sign-in failed: ${response.status()}`);
}

export const test = base.extend<Fixtures, WorkerFixtures>({
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
  unconfigured: [
    async ({}, use) => {
      const harness = await startHarness({ withKey: false });
      try {
        await use(harness);
      } finally {
        await harness.close();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],
  fresh: [
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
    await signIn(page, harness);
    await use(page);
  },
  signedInUnconfigured: async ({ page, unconfigured }, use) => {
    await signIn(page, unconfigured);
    await use(page);
  },
  signedInFresh: async ({ page, fresh }, use) => {
    await signIn(page, fresh);
    await use(page);
  },
});

export { expect } from "@playwright/test";
