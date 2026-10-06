import type { OutboundEventDataMap } from "@invisible-dots/shared";
import { expect, test } from "./fixtures.js";
import { lookOf } from "./look.js";

/** A tool call as the engine reports it once it has ended. */
function called(tool: string, target: string, change: Partial<OutboundEventDataMap["tool.called"]> = {}): OutboundEventDataMap["tool.called"] {
  return { tool, permission: "browser.act", decision: "allow", ok: true, duration_ms: 80, target, ...change };
}

test("the Computer page shows the screen, the files and what the computer uses", async ({ signedIn: page, harness }) => {
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
  await expect(page.getByRole("button", { name: /^Computer: STOPPED/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Automations" })).toContainText("Paused: you stopped this computer, so its automations do not run");
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  await expect(page.getByText("What it uses is shown while the computer runs.")).toBeVisible();
});

test("the browsers are made here, watched with the page the Dot is on, closed and deleted", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("computer-browsers");
  const guest = harness.driver.guestOf(dot.id);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/computer?view=browser`);
  await expect(page.getByText("No browsers yet")).toBeVisible();

  // Nothing below reloads the page: this marker would not survive it.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 7));

  // A bad proxy is refused before the control plane hears of it.
  await page.getByRole("button", { name: "New browser" }).click();
  const dialog = page.getByRole("dialog", { name: "New browser" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Shopping");
  // The field does not show what is typed: a proxy URL may hold a password.
  await expect(dialog.getByLabel(/^Proxy/)).toHaveAttribute("type", "password");
  await dialog.getByLabel(/^Proxy/).fill("ftp://host");
  await dialog.getByRole("button", { name: "Create browser" }).click();
  await expect(dialog.getByRole("alert")).toContainText("http, https, socks4 or socks5");
  expect(await harness.api.listIdentities(dot.id)).toEqual([]);

  await dialog.getByLabel(/^Proxy/).fill("http://user:hunter2@proxy.example:8080");
  await dialog.getByRole("button", { name: "Create browser" }).click();
  const card = page.getByRole("article", { name: "Shopping" });
  await expect(card).toBeVisible();
  await expect(card.getByText(/^Status: Closed$/)).toBeVisible();
  // The password shows nowhere: not the form's field after it closes, nor the card.
  await expect(card.getByText("http://user:***@proxy.example:8080")).toBeVisible();
  await expect(page.getByText("hunter2")).toHaveCount(0);

  // The Dot opens it: its window shows, without a bar page until the Dot has opened one.
  const [made] = await harness.api.listIdentities(dot.id);
  guest.launchIdentity(made!.id);
  await expect(card.getByText(/^Status: Open$/)).toBeVisible();
  const stage = page.getByRole("region", { name: "Window of Shopping" });
  await expect(stage.getByRole("img", { name: /browser "Shopping"/ })).toHaveAttribute("src", /^blob:/);
  await expect(stage.getByText("The Dot has not opened a page in this browser yet")).toBeVisible();

  // It opens a page: the bar shows it and the card says the Dot is working in it.
  guest.emit("tool.called", called("browser_navigate", `${made!.id}: https://example.com/fares?q=***`, { permission: "browser.navigate" }));
  await expect(stage.getByLabel("Page the Dot last opened")).toHaveText("https://example.com/fares?q=***");
  await expect(card.getByText("The Dot is using this now")).toBeVisible();

  // Closing a browser the Dot is working in is asked about first.
  await card.getByRole("button", { name: /^Close/ }).click();
  const ask = page.getByRole("dialog", { name: "Close Shopping?" });
  await ask.getByRole("button", { name: "Keep it" }).click();
  expect((await harness.api.listIdentities(dot.id))[0]!.status).toBe("open");
  await card.getByRole("button", { name: /^Close/ }).click();
  await ask.getByRole("button", { name: "Close browser" }).click();
  await expect(card.getByText(/^Status: Closed$/)).toBeVisible();
  await expect(stage).toHaveCount(0);
  expect((await harness.api.listIdentities(dot.id))[0]!.status).toBe("available");

  // Deleting asks, says what is lost, and removes the profile.
  await card.getByRole("button", { name: /^Delete/ }).click();
  const confirm = page.getByRole("dialog", { name: "Delete Shopping?" });
  await expect(confirm).toContainText("cannot be undone");
  await confirm.getByRole("button", { name: "Delete identity" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("No browsers yet")).toBeVisible();
  expect(await harness.api.listIdentities(dot.id)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(7);
});

test("the old browser identities address leads to the Browser view", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("computer-redirect");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/identities`);
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/computer\\?view=browser$`));
  await expect(page.getByRole("link", { name: "Browser", exact: true })).toHaveAttribute("aria-current", "page");
});

test("a stopped computer says so on the screen, the browsers and the files, and starts from there", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("computer-stopped");
  harness.driver.guestOf(dot.id).putFile("/home/dot/notes.txt", "hello");
  await harness.api.stopComputer(dot.id);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/computer`);
  await expect(page.getByRole("button", { name: /^Computer: STOPPED/ })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Start the computer to see its screen" })).toBeVisible();
  const views = page.getByRole("navigation", { name: "Computer views" });
  await views.getByRole("link", { name: "Browser" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Start the computer to see its browsers" })).toBeVisible();
  await views.getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Start the computer to see its files" })).toBeVisible();

  await page.getByRole("button", { name: "Start the computer" }).click();
  await expect(page.getByRole("link", { name: "notes.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Computer: RUNNING/ })).toBeVisible();
});

test("the Computer page fits a phone: no sideways scroll at 390 px", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("computer-phone");
  const guest = harness.driver.guestOf(dot.id);
  guest.putFile("/home/dot/a-file-with-a-very-long-name-that-has-no-break-in-it-at-all-and-keeps-going-and-going.txt", "x");
  const made = await harness.api.createIdentity(dot.id, { name: "A browser named for a site with a long address name.example.com", proxy: "socks5://user:pw@a-proxy-host-with-a-long-name.example.com:1080" });
  guest.launchIdentity(made.id);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await page.goto(`${harness.webUrl}/dots/${dot.id}/computer`);
  await expect(page.getByRole("img", { name: /desktop/ })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  for (const view of ["browser", "files", "usage"]) {
    await page.getByRole("navigation", { name: "Computer views" }).getByRole("link", { name: new RegExp(`^${view}$`, "i") }).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}`));
    if (view === "browser") await expect(page.getByRole("article")).toBeVisible();
    if (view === "files") await expect(page.getByRole("table")).toBeVisible();
    if (view === "usage") await expect(page.getByRole("region", { name: "Images" })).toBeVisible();
    expect(await overflow(), view).toBeLessThanOrEqual(0);
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`the Computer page is readable in ${scheme}: chips, buttons, the views bar and the labels of facts`, async ({ signedIn: page, harness }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await harness.createDot(`computer-look-${scheme}`);
    const guest = harness.driver.guestOf(dot.id);
    guest.putFile("/home/dot/notes.txt", "x");
    const open = await harness.api.createIdentity(dot.id, { name: "Open one" });
    await harness.api.createIdentity(dot.id, { name: "Closed one" });
    guest.launchIdentity(open.id);
    guest.emit("tool.called", called("browser_click", `${open.id}: #go`));
    await page.goto(`${harness.webUrl}/dots/${dot.id}/computer?view=browser`);
    await expect(page.getByRole("article", { name: "Open one" }).getByText("The Dot is using this now")).toBeVisible();

    const texts: Record<string, string> = {
      "the open chip": "article[aria-label='Open one'] span:has-text('Open')",
      "the closed chip": "article[aria-label='Closed one'] span:has-text('Closed')",
      "the using-now mark": "article[aria-label='Open one'] span:has-text('using this now')",
      "the current view link": "nav[aria-label='Computer views'] a[aria-current=page]",
      "another view link": "nav[aria-label='Computer views'] a:not([aria-current])",
      "a card's Close button": "article[aria-label='Open one'] button:has-text('Close')",
      "the page bar": "section[aria-label='Window of Open one'] [aria-label='Page the Dot last opened']",
      "a fact's label": "article[aria-label='Open one'] dt",
    };
    for (const [name, selector] of Object.entries(texts)) {
      expect((await lookOf(page, selector)).contrast, name).toBeGreaterThanOrEqual(4.5);
    }
  });
}
