import { test as base } from "@playwright/test";
import { startHarness, type Harness } from "./harness.js";

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

export const test = base.extend<{}, WorkerFixtures>({
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
});

export { expect } from "@playwright/test";
