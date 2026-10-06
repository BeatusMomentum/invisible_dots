import { join } from "node:path";
import type { DoctorCheck } from "@invisible-dots/shared";
import { expect, test } from "./fixtures.js";

const MISSING_IMAGE: DoctorCheck = { id: "golden-image", label: "golden image", status: "missing", detail: "none in the images folder", fix: "invisible-dots image build" };

test("on the first run Home lists what the host lacks with its commands, takes the key, and turns green when the last thing is done", async ({ signedInUnconfigured: page, unconfigured: harness }) => {
  const healthy = harness.host.images;
  harness.host.images = [MISSING_IMAGE, healthy[1]!];
  try {
    await page.goto(`${harness.webUrl}/`);
    await expect(page.getByRole("heading", { name: "No Dots yet" })).toBeVisible();
    const checklist = page.getByRole("region", { name: "Get this computer ready" });
    await expect(checklist.getByText(/2 things need attention/)).toBeVisible();
    await expect(checklist.getByText("golden image: Needs attention")).toBeVisible();
    await expect(checklist.getByText("OpenRouter key: Needs attention")).toBeVisible();
    await expect(checklist.getByText("invisible-dots image build")).toBeVisible();
    // The rail says it too, and links to where the key is entered.
    await expect(page.getByRole("complementary", { name: "Navigation" }).getByRole("link", { name: "No OpenRouter key stored yet" })).toBeVisible();

    // The image is built in a terminal; coming back and checking again shows it.
    harness.host.images = healthy;
    await checklist.getByRole("button", { name: "Check again" }).click();
    await expect(checklist.getByText("golden image: Ready")).toBeVisible();
    await expect(checklist.getByText(/1 thing needs attention/)).toBeVisible();

    // The key: write-only, stored, and the page agrees without a reload.
    const field = checklist.getByLabel("OpenRouter API key");
    await expect(field).toHaveAttribute("type", "password");
    await field.fill("sk-or-first-run-0123456789");
    await checklist.getByRole("button", { name: "Save key" }).click();
    // Not scoped to `checklist`: the region is named for its state and is "This computer is ready" a moment later.
    await expect(page.getByText("Saved. No Dot's computer is running, so each gets the key when it starts.")).toBeVisible();
    await expect(page.getByRole("region", { name: "This computer is ready" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Navigation" }).getByText("No OpenRouter key stored yet")).toHaveCount(0);
    expect(await harness.api.health()).toMatchObject({ openrouter_configured: true });
    expect(await page.content()).not.toContain("sk-or-first-run-0123456789");

    await page.getByRole("link", { name: "Create your first Dot" }).click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole("region", { name: "Before you create" }).getByText("OpenRouter key: Ready")).toBeVisible();
  } finally {
    harness.host.images = healthy;
  }
});

test("the Settings page is in the rail and shows the checks, the key, the appearance, the session and where the data is", async ({ signedIn: page, harness }) => {
  await page.goto(`${harness.webUrl}/`);
  await page.getByRole("complementary", { name: "Navigation" }).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page).toHaveTitle(/^Settings/);
  await expect(page.getByRole("complementary", { name: "Navigation" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

  const checks = page.getByRole("region", { name: "Host checks" });
  await expect(checks.getByText("Control plane: Ready")).toBeVisible();
  await expect(checks.getByText("QEMU: Ready")).toBeVisible();
  await expect(checks.getByText("Everything a Dot needs is in place.")).toBeVisible();
  await expect(page.getByRole("region", { name: "OpenRouter key" }).getByText("A key is stored.")).toBeVisible();

  const about = page.getByRole("region", { name: "About" });
  await expect(about.getByText("embedded PostgreSQL", { exact: false })).toBeVisible();
  await expect(about.getByText(harness.home, { exact: true })).toBeVisible();
  await expect(about.getByText(join(harness.home, "logs"), { exact: true })).toBeVisible();
  await expect(about.getByText("invisible-dots logs <dot>")).toBeVisible();
});

test("a missing host check shows its command here too, and checking again follows the host", async ({ signedIn: page, harness }) => {
  const healthy = harness.host.images;
  harness.host.images = [MISSING_IMAGE, healthy[1]!];
  try {
    await page.goto(`${harness.webUrl}/settings`);
    const checks = page.getByRole("region", { name: "Host checks" });
    await expect(checks.getByText("golden image: Needs attention")).toBeVisible();
    await expect(checks.getByText("invisible-dots image build")).toBeVisible();
    await expect(checks.getByText(/1 thing needs attention/)).toBeVisible();
    await expect(checks.getByRole("button", { name: "Copy the fix for golden image" })).toBeVisible();
    harness.host.images = healthy;
    await checks.getByRole("button", { name: "Check again" }).click();
    await expect(checks.getByText("golden image: Ready")).toBeVisible();
    await expect(checks.getByText("invisible-dots image build")).toHaveCount(0);
  } finally {
    harness.host.images = healthy;
  }
});

test("a new key is pushed to the running Dots, and a key that cannot be one is refused before it is sent", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("settings-key");
  await page.goto(`${harness.webUrl}/settings`);
  const key = page.getByRole("region", { name: "OpenRouter key" });
  const field = key.getByLabel("Replace the key");

  await field.fill("has a space");
  await key.getByRole("button", { name: "Replace key" }).click();
  await expect(key.getByText(/must be printable ASCII without spaces/)).toBeVisible();
  expect(harness.driver.guestOf(dot.id).openrouterKey).toBe("sk-or-e2e-0123456789abcdef");

  await field.fill("sk-or-replacement-0123456789");
  await key.getByRole("button", { name: "Replace key" }).click();
  await expect(key.getByText(/^Saved\. Pushed to \d+ running Dots?\.$/)).toBeVisible();
  await expect(field).toHaveValue("");
  expect(harness.driver.guestOf(dot.id).openrouterKey).toBe("sk-or-replacement-0123456789");
  expect(await page.content()).not.toContain("sk-or-replacement-0123456789");
});

test("the theme is chosen on the page, applied at once and kept across a reload", async ({ signedIn: page, harness }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${harness.webUrl}/settings`);
  const appearance = page.getByRole("region", { name: "Appearance" });
  await expect(appearance.getByRole("radio", { name: /System/ })).toBeChecked();
  await appearance.getByRole("radio", { name: /Dark/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("region", { name: "Appearance" }).getByRole("radio", { name: /Dark/ })).toBeChecked();
  await page.getByRole("region", { name: "Appearance" }).getByRole("radio", { name: /System/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("signing out from the settings page ends the session", async ({ signedIn: page, harness }) => {
  await page.goto(`${harness.webUrl}/settings`);
  await page.getByRole("region", { name: "Session" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.goto(`${harness.webUrl}/settings`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("the login page is a card with the token field focused, and Settings and Home fit a phone", async ({ signedIn: page, harness }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/settings", "/"]) {
    await page.goto(`${harness.webUrl}${path}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  }
  await page.context().clearCookies();
  await page.goto(`${harness.webUrl}/login`);
  await expect(page.getByLabel("API token")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test("the settings page is usable from the keyboard alone", async ({ signedIn: page, harness }) => {
  await page.goto(`${harness.webUrl}/settings`);
  const key = page.getByRole("region", { name: "OpenRouter key" });
  await key.getByLabel("Replace the key").focus();
  await page.keyboard.type("sk-or-by-keyboard-0123456789");
  await page.keyboard.press("Enter");
  await expect(key.getByText(/^Saved\./)).toBeVisible();
  const appearance = page.getByRole("region", { name: "Appearance" });
  await appearance.getByRole("radio", { name: /Light/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(appearance.getByRole("radio", { name: /Dark/ })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
