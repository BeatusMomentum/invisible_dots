import { expect, test } from "./fixtures.js";

test("the login page has no rail, refuses a wrong token and lets the right one in", async ({ page, harness }) => {
  const calls: string[] = [];
  page.on("request", (request) => calls.push(new URL(request.url()).pathname));
  await page.goto(`${harness.webUrl}/login`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  // Give an effect time to start a request, if one were going to.
  await page.waitForTimeout(500);
  expect(calls.filter((path) => path.startsWith("/api/"))).toEqual([]);

  await page.getByLabel("API token").fill("not-the-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "not the API token" })).toBeVisible();

  await page.getByLabel("API token").fill(harness.token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("signing out returns to the login page, and the pages behind it ask for the token again", async ({ signedIn: page, harness }) => {
  await page.goto(`${harness.webUrl}/`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.goto(`${harness.webUrl}/inbox`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("the rail lists the Dots and a Dot's page shows its header and its tabs", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("shell-header", "Watch the fares from Milan to Lisbon");
  await page.goto(`${harness.webUrl}/`);
  const dots = page.getByRole("navigation", { name: "Dots" });
  await dots.getByRole("link", { name: /shell-header/ }).click();

  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/chat$`));
  await expect(page.getByRole("heading", { level: 1, name: "shell-header" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Watch the fares/ })).toBeVisible();
  await expect(dots.getByRole("link", { name: /shell-header/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("img", { name: "Ready" }).first()).toBeVisible();
  await expect(page.getByText("$0.00")).toBeVisible();

  const tabs = page.getByRole("navigation", { name: "Dot sections" });
  await expect(tabs.getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Tasks" }).click();
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/tasks$`));
  await expect(tabs.getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
});

test("a Dot that waits for an approval shows it everywhere at once, live, and clears it when it is answered", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("shell-asks");
  await page.goto(`${harness.webUrl}/`);
  const link = page.getByRole("navigation", { name: "Dots" }).getByRole("link", { name: /shell-asks/ });
  await expect(link.getByRole("img", { name: "Ready" })).toBeVisible();
  const titleBefore = await page.title();

  harness.driver.guestOf(dot.id).requestApproval(undefined);

  await expect(link.getByRole("img", { name: "Waiting for you" })).toBeVisible();
  await expect(link.getByLabel("1 waiting")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Inbox/ }).getByLabel("1 need you")).toBeVisible();
  await expect(page).toHaveTitle(`(1) ${titleBefore}`);

  const [approval] = await harness.api.listApprovals("pending");
  await harness.api.approve(approval!.id);

  await expect(link.getByLabel("1 waiting")).toHaveCount(0);
  await expect(page).toHaveTitle(titleBefore);
});

test("the computer pill stops and starts the computer", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("shell-power");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  const pill = page.getByRole("button", { name: /^Computer: RUNNING/ });
  await pill.click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: /^Computer: STOPPED/ })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Dots" }).getByRole("link", { name: /shell-power/ }).getByRole("img", { name: "Computer stopped" })).toBeVisible();

  await page.getByRole("button", { name: /^Computer: STOPPED/ }).click();
  await page.getByRole("menuitem", { name: "Start" }).click();
  await expect(page.getByRole("button", { name: /^Computer: RUNNING/ })).toBeVisible();
});

test("the theme follows the system, can be chosen, and is applied before the page is drawn", async ({ signedIn: page, harness }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${harness.webUrl}/`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.getByRole("button", { name: "Theme: System" }).click();
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(darkBackground);

  // The choice survives a reload, against a system that says dark: the inline script has set it by the time the
  // document is parsed, before any module has run.
  await page.goto(`${harness.webUrl}/`, { waitUntil: "commit" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await expect(page.getByRole("button", { name: "Theme: Light" })).toBeVisible();

  await page.getByRole("button", { name: "Theme: Light" }).click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("on a phone the rail is a sheet behind the menu button and nothing scrolls sideways", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("shell-phone", "A goal long enough to run past the edge of a narrow screen if nothing held it back, word after word");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);

  await expect(page.getByRole("complementary", { name: "Navigation" })).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "shell-phone" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);

  await page.getByRole("button", { name: "Open the menu" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("link", { name: /shell-phone/ })).toBeVisible();
  await sheet.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(`${harness.webUrl}/`);
  await expect(sheet).toBeHidden();
});

test("the whole shell works from the keyboard", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("shell-keys");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  await page.getByRole("button", { name: /^Computer: RUNNING/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  // The skip link is the first stop of a page that does not take the focus itself (the chat does, for its box).
  await page.goto(`${harness.webUrl}/inbox`);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});

test("a focused control keeps an outline under forced colors, where box shadows are not drawn, and draws its ring as a shadow otherwise", async ({ signedIn: page, harness }) => {
  await page.goto(`${harness.webUrl}/new`);
  await expect(page.getByRole("heading", { name: "Create a Dot" })).toBeVisible();
  const focused = async () => {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const tag = await page.evaluate(() => document.activeElement?.tagName ?? "");
      if (["BUTTON", "INPUT", "TEXTAREA"].includes(tag)) break;
    }
    return page.evaluate(() => {
      const style = getComputedStyle(document.activeElement!);
      return { tag: document.activeElement!.tagName, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, boxShadow: style.boxShadow };
    });
  };

  // Ordinary colors: the ring is a shadow, and there is no outline besides it.
  const ordinary = await focused();
  expect(ordinary.boxShadow).not.toBe("none");
  expect(ordinary.outlineStyle).toBe("none");

  // Forced colors: no shadow is drawn, so the indicator is the outline, in a system color.
  await page.emulateMedia({ forcedColors: "active" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Create a Dot" })).toBeVisible();
  const forced = await focused();
  expect(forced.outlineStyle).toBe("solid");
  expect(forced.outlineWidth).toBe("2px");
  expect(forced.outlineColor).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
});
