import { expect, test } from "@playwright/test";
import { startHarness } from "./harness.js";

test("the page says, at the top and as an alert, when the control plane stops answering, also on a phone", async ({ page }) => {
  test.setTimeout(180_000);
  // A control plane of its own: this one is stopped, and the others of the run must keep theirs.
  const harness = await startHarness();
  try {
    await page.goto(`${harness.webUrl}/`);
    await expect(page.getByRole("complementary", { name: "Navigation" }).getByText("Live")).toBeVisible();
    const banner = page.getByRole("alert").filter({ hasText: "The control plane does not answer" });
    await expect(banner).toHaveCount(0);

    await harness.stopApi();
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("out of date");
    // It is above the page, not in the rail, so a phone (where the rail is a closed sheet) sees it too.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(banner).toBeVisible();
    const box = await banner.boundingBox();
    expect(box!.y).toBeLessThan(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  } finally {
    await harness.close();
  }
});
