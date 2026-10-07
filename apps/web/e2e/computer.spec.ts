import { expect, test } from "./fixtures.js";
import { lookOf } from "./look.js";

test("the Computer page shows the screen, the files and what the computer uses", async ({ page, harness }) => {
  const dot = await harness.createDot("computer-views");
  const guest = harness.driver.guestOf(dot.id);
  guest.putFile("/home/dot/notes.txt", "Remember the milk.\n");
  guest.putFile("/home/dot/memory/trips/rome.md", "Rome in May");
  guest.putFile("/home/dot/shot.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
  guest.putFile("/home/dot/archive.zip", Uint8Array.from([0x50, 0x4b, 3, 4]));
  await page.goto(`${harness.webUrl}/dots/${dot.id}/computer`);

  await expect(page.getByRole("link", { name: "Computer", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Browser identities" })).toHaveCount(0);

  // Screen: a live picture, and no pretence of control.
  await expect(page.getByRole("img", { name: /current picture of the desktop/ })).toHaveAttribute("src", /^blob:/);
  await expect(page.getByText("The Dot has control. You are watching.")).toBeVisible();
  await expect(page.getByText("LIVE", { exact: true })).toBeVisible();

  // Files: folders first, a folder opens, a text file shows its text, and the way back is a link.
  const views = page.getByRole("navigation", { name: "Computer views" });
  await views.getByRole("link", { name: "Files" }).click();
  await expect(page).toHaveURL(/view=files$/);
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("row").nth(1)).toContainText("memory");
  await table.getByRole("link", { name: /^memory/ }).click();
  await table.getByRole("link", { name: /^trips/ }).click();
  await table.getByRole("link", { name: "rome.md" }).click();
  await expect(page.getByLabel("Contents of rome.md")).toHaveText("Rome in May");
  await expect(page.getByRole("navigation", { name: "Folder" }).getByRole("link")).toHaveText(["Home", "memory", "trips"]);
  await page.getByRole("navigation", { name: "Folder" }).getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/path=%2Fhome%2Fdot$/);

  // A reload lands on the same file: the address holds it.
  await table.getByRole("link", { name: "notes.txt" }).click();
  await expect(page.getByLabel("Contents of notes.txt")).toHaveText("Remember the milk.");
  await page.reload();
  await expect(page.getByLabel("Contents of notes.txt")).toHaveText("Remember the milk.");

  await table.getByRole("link", { name: "shot.png" }).click();
  await expect(page.getByRole("img", { name: "The picture shot.png" })).toHaveAttribute("src", /^blob:/);

  // Nothing but a download for what a page does not show.
  await table.getByRole("link", { name: "archive.zip" }).click();
  const preview = page.getByRole("region", { name: "File archive.zip" });
  await expect(preview.getByText(/not shown here/)).toBeVisible();
  const download = page.waitForEvent("download");
  await preview.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("archive.zip");

  // A folder that is not there says so, and leads home.
  await page.goto(`${harness.webUrl}/dots/${dot.id}/computer?view=files&path=/home/dot/nowhere`);
  await expect(page.getByRole("alert").getByText("This folder does not exist (any more).")).toBeVisible();
  await page.getByRole("link", { name: "Go to the home folder" }).click();
  await expect(page.getByRole("table")).toBeVisible();

  // Usage: given and used, the images, and the actions the state allows.
  await views.getByRole("link", { name: "Usage" }).click();
  await expect(page.getByRole("meter", { name: "Memory used" })).toHaveAttribute("aria-valuenow", "25");
  await expect(page.getByRole("meter", { name: "Disk used" })).toHaveAttribute("aria-valuenow", "13");
  await expect(page.getByRole("region", { name: "Given to the computer" }).getByText("15m")).toBeVisible();
  await expect(page.getByRole("region", { name: "Images" })).toContainText("golden-");
  await expect(page.getByRole("region", { name: "Model spend" })).toContainText("$0.00");
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  // The Dot's automations are the Dot's own: the page says when the next one is due (none is yet).
  await expect(page.getByRole("region", { name: "Automations" })).toContainText("No automation is due.");
  // The engine reports a run that is due: that is what the person's stop then holds back (a Dot with no automation has nothing to pause).
  guest.emit("automation.next_run", { next_run_at_ms: Date.now() + 6 * 60 * 60 * 1000 });
  await expect(page.getByRole("region", { name: "Automations" })).toContainText("Next automation:");
  // Stopping asks, and says what it costs.
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Its automations do not run while it is stopped");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Computer: Stopped/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Automations" })).toContainText("Paused: you stopped this computer, so its automations do not run");
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await expect(page.getByText("What it uses is shown while the computer runs.")).toBeVisible();
});

test("a stopped computer says so on the screen and the files, and starts from there", async ({ page, harness }) => {
  const dot = await harness.createDot("computer-stopped");
  harness.driver.guestOf(dot.id).putFile("/home/dot/notes.txt", "hello");
  await harness.api.stopComputer(dot.id);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/computer`);
  await expect(page.getByRole("button", { name: /^Computer: Stopped/ })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Start the computer to see its screen" })).toBeVisible();
  const views = page.getByRole("navigation", { name: "Computer views" });
  await expect(views.getByRole("link", { name: "Browser" })).toHaveCount(0);
  await views.getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Start the computer to see its files" })).toBeVisible();

  await page.getByRole("button", { name: "Start the computer" }).click();
  await expect(page.getByRole("link", { name: "notes.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Computer: Running/ })).toBeVisible();
});

test("the Computer page fits a phone: no sideways scroll at 390 px", async ({ page, harness }) => {
  const dot = await harness.createDot("computer-phone");
  const guest = harness.driver.guestOf(dot.id);
  guest.putFile("/home/dot/a-file-with-a-very-long-name-that-has-no-break-in-it-at-all-and-keeps-going-and-going.txt", "x");
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await page.goto(`${harness.webUrl}/dots/${dot.id}/computer`);
  await expect(page.getByRole("img", { name: /desktop/ })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  for (const view of ["files", "usage"]) {
    await page.getByRole("navigation", { name: "Computer views" }).getByRole("link", { name: new RegExp(`^${view}$`, "i") }).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}`));
    if (view === "files") await expect(page.getByRole("table")).toBeVisible();
    if (view === "usage") await expect(page.getByRole("region", { name: "Images" })).toBeVisible();
    expect(await overflow(), view).toBeLessThanOrEqual(0);
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`the Computer page is readable in ${scheme}: the views bar and the labels of facts`, async ({ page, harness }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await harness.createDot(`computer-look-${scheme}`);
    await page.goto(`${harness.webUrl}/dots/${dot.id}/computer?view=usage`);
    await expect(page.getByRole("region", { name: "Images" })).toBeVisible();

    const texts: Record<string, string> = {
      "the current view link": "nav[aria-label='Computer views'] a[aria-current=page]",
      "another view link": "nav[aria-label='Computer views'] a:not([aria-current])",
      "a fact's label": "main dl dt",
    };
    for (const [name, selector] of Object.entries(texts)) {
      expect((await lookOf(page, selector)).contrast, name).toBeGreaterThanOrEqual(4.5);
    }
  });
}
