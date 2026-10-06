import type { Automation, OutboundEventDataMap } from "@invisible-dots/shared";
import { expect, test } from "./fixtures.js";
import { lookOf } from "./look.js";

/** A tool call as the engine reports it once it has ended. */
function called(tool: string, target: string, change: Partial<OutboundEventDataMap["tool.called"]> = {}): OutboundEventDataMap["tool.called"] {
  return { tool, permission: "files.write", decision: "allow", ok: true, duration_ms: 40, target, ...change };
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

function automation(id: string, name: string, change: Partial<Automation> = {}): Automation {
  return {
    id,
    name,
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Rome" },
    message: "Check the fares and tell me if one dropped.",
    next_run_at_ms: Date.now() + 3 * 3_600_000 + 60_000,
    last_run_at_ms: null,
    last_status: null,
    last_error: null,
    delete_after_run: false,
    created_at_ms: Date.now() - 86_400_000,
    ...change,
  };
}

test("the Memory tab lists the Dot's notes, reads one as Markdown, follows a note the Dot writes, and keeps the open note in the address", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("memory-notes");
  const guest = harness.driver.guestOf(dot.id);
  guest.putFile("/home/dot/memory/fares.md", "# Fares\n\nCheapest in **May**.", hoursAgo(5));
  guest.putFile("/home/dot/memory/trips/rome.md", "Rome in May\n\n<script>window.pwned = 1</script>", hoursAgo(1));
  guest.putFile("/home/dot/notes.txt", "outside the memory folder");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);

  // The tab is in the bar, and leads to the notes.
  await page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: "Memory" }).click();
  await expect(page).toHaveURL(/\/memory$/);
  await expect(page.locator(".legacy")).toHaveCount(0);
  const list = page.getByRole("list", { name: "Notes" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  // Newest written first, the folder of a note before its name.
  await expect(list.getByRole("listitem").nth(0)).toContainText("trips/rome.md");
  await expect(list.getByRole("listitem").nth(0)).toContainText("Written 1h ago");
  await expect(list.getByRole("listitem").nth(1)).toContainText("fares.md");
  await expect(page.getByText("outside the memory folder")).toHaveCount(0);

  // Search by name.
  await page.getByRole("searchbox", { name: "Search notes by name" }).fill("FARES");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search notes by name" }).fill("nothing like it");
  await expect(page.getByRole("status").filter({ hasText: "No note has" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search notes by name" }).fill("");

  // A note opens as rendered Markdown; the address holds it, so a reload lands on it.
  await list.getByRole("link", { name: /fares\.md/ }).click();
  await expect(page).toHaveURL(/note=fares\.md$/);
  const reader = page.getByRole("region", { name: "File fares.md" });
  await expect(reader.getByRole("heading", { name: "Fares", exact: true })).toBeVisible();
  await expect(reader.locator("strong")).toHaveText("May");
  await page.reload();
  await expect(page.getByRole("region", { name: "File fares.md" }).getByRole("heading", { name: "Fares", exact: true })).toBeVisible();

  // Markup in a note is shown as nothing, never run.
  await page.getByRole("list", { name: "Notes" }).getByRole("link", { name: /rome\.md/ }).click();
  await expect(page.getByRole("region", { name: "File rome.md" }).getByText("Rome in May")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();

  // A note the Dot writes while the page is open: a chip, the list, and the open note rewritten in place.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 7));
  guest.putFile("/home/dot/memory/trips/lisbon.md", "Lisbon in June");
  guest.emit("tool.called", called("write_file", "/home/dot/memory/trips/lisbon.md"));
  guest.emit("memory.written", { key: "trips/lisbon.md" });
  const chips = page.locator("[data-slot=memory-chips]");
  await expect(chips.getByText("remembered 1")).toBeVisible();
  await expect(chips.getByRole("link")).toHaveText("trips/lisbon.md (added)");
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("listitem").nth(0)).toContainText("trips/lisbon.md");
  guest.putFile("/home/dot/memory/trips/rome.md", "Rome in June instead");
  guest.emit("memory.written", { key: "trips/rome.md" });
  await expect(page.getByRole("region", { name: "File rome.md" }).getByText("Rome in June instead")).toBeVisible();
  await expect(chips.getByRole("link")).toHaveText(["trips/rome.md (updated)", "trips/lisbon.md (added)"]);
  await chips.getByRole("link", { name: /lisbon/ }).click();
  await expect(page.getByRole("region", { name: "File lisbon.md" }).getByText("Lisbon in June")).toBeVisible();
  // None of this reloaded the page.
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(7);

  // A note that is not there says so.
  await page.goto(`${harness.webUrl}/dots/${dot.id}/memory?note=gone.md`);
  await expect(page.getByText("There is no note called gone.md (any more).")).toBeVisible();
});

test("the chip of a note in the chat leads to the note", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("memory-chat-chip");
  const guest = harness.driver.guestOf(dot.id);
  guest.putFile("/home/dot/memory/trips/lisbon.md", "Lisbon in June");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  guest.emit("tool.called", called("write_file", "/home/dot/memory/trips/lisbon.md"));
  guest.emit("memory.written", { key: "trips/lisbon.md" });
  await page.getByRole("link", { name: "trips/lisbon.md" }).click();
  await expect(page).toHaveURL(/\/memory\?note=trips%2Flisbon\.md$/);
  await expect(page.getByRole("region", { name: "File lisbon.md" }).getByText("Lisbon in June")).toBeVisible();
});

test("an empty memory says so, and the switch turns the Dot's memory off for good: saved, pushed, and the memory tools no longer offered", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("memory-switch");
  const guest = harness.driver.guestOf(dot.id);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/memory`);
  await expect(page.getByText(/has not written a note yet/)).toBeVisible();

  const control = page.getByRole("switch", { name: /Memory is on/ });
  await expect(control).toBeChecked();
  expect((await harness.api.listTools(dot.id)).find((tool) => tool.name === "memory_search")?.offered).toBe(true);
  await control.click();
  await expect(page.getByText("Memory is off. The change applies from the Dot's next turn.")).toBeVisible();
  await expect(page.getByRole("switch", { name: /Memory is off/ })).not.toBeChecked();
  await expect(page.getByText(/not offered the tools that search and read its notes/)).toBeVisible();

  // The control plane saved it and the Dot's engine has it.
  expect((await harness.api.getDot(dot.id)).config.memory.enabled).toBe(false);
  await expect.poll(() => guest.config?.memory.enabled).toBe(false);
  expect((await harness.api.listTools(dot.id)).find((tool) => tool.name === "memory_search")?.offered).toBe(false);

  // A reload shows what is saved, and the other way works too.
  await page.reload();
  await page.getByRole("switch", { name: /Memory is off/ }).click();
  await expect(page.getByRole("switch", { name: /Memory is on/ })).toBeChecked();
  expect((await harness.api.getDot(dot.id)).config.memory.enabled).toBe(true);
});

test("a config changed in another tab is not undone by the switch", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("memory-switch-stale");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/memory`);
  await expect(page.getByRole("switch", { name: /Memory is on/ })).toBeChecked();
  // Another tab (here: the API) changes the goal after this page read the Dot.
  const read = await harness.api.getDot(dot.id);
  await harness.api.updateDot(dot.id, { ...read.config, goal: "a goal set elsewhere" });
  await page.getByRole("switch", { name: /Memory is on/ }).click();
  const refusal = page.getByRole("alert").filter({ hasText: "Memory was not changed" });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("changed after you read it");
  const after = await harness.api.getDot(dot.id);
  expect(after.config.memory.enabled).toBe(true);
  expect(after.config.goal).toBe("a goal set elsewhere");
  // The page has read the Dot again: the same click now goes through, and keeps the goal set elsewhere.
  await page.getByRole("switch", { name: /Memory is on/ }).click();
  await expect(page.getByRole("switch", { name: /Memory is off/ })).not.toBeChecked();
  const saved = await harness.api.getDot(dot.id);
  expect(saved.config.memory.enabled).toBe(false);
  expect(saved.config.goal).toBe("a goal set elsewhere");
});

test("the automations: schedule in words, next and last run, paused and resumed, deleted after a question, and new ones appear when the Dot makes them", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("memory-automations");
  const guest = harness.driver.guestOf(dot.id);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/memory?view=automations`);
  await expect(page.getByRole("link", { name: "Automations", exact: true })).toHaveAttribute("aria-current", "page");
  // Nothing yet: it says how one comes to exist (the permission asks by default).
  await expect(page.getByText(/asks you first/)).toBeVisible();
  await expect(page.getByRole("switch", { name: /^Memory/ })).toHaveCount(0);

  // Nothing below reloads the page: this marker would not survive it.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 7));

  // The Dot sets one up: its cron tool ran, and the list follows.
  guest.putAutomation(
    automation("a1", "Morning fares", { last_run_at_ms: Date.now() - 2 * 3_600_000 - 60_000, last_status: "error", last_error: "the page did not load" }),
  );
  guest.putAutomation(automation("a2", "Evening digest", { schedule: { kind: "every", every_ms: 86_400_000 }, message: "Send me a digest", next_run_at_ms: Date.now() + 9 * 3_600_000 }));
  guest.emit("tool.called", called("cron", "add: Morning fares", { permission: "automations" }));
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAccessibleName("Morning fares");
  const morning = page.getByRole("article", { name: "Morning fares" });
  await expect(morning.getByText("every weekday at 09:00 (Europe/Rome)")).toBeVisible();
  await expect(morning.getByText(/\(in 3h\)$/)).toBeVisible();
  await expect(morning.getByText("Failed")).toBeVisible();
  await expect(morning.getByText("the page did not load")).toBeVisible();
  await expect(morning.getByText(/Check the fares and tell me/)).toBeVisible();
  await expect(page.getByRole("article", { name: "Evening digest" }).getByText("every day", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Evening digest" }).getByText("Has not run yet")).toBeVisible();

  // Pause, then resume.
  await morning.getByRole("switch").click();
  await expect(morning.getByText("Paused", { exact: true })).toBeVisible();
  await expect(morning.getByRole("switch")).not.toBeChecked();
  expect(guest.automations.get("a1")?.enabled).toBe(false);
  // A paused automation sorts after the one that will run.
  await expect(cards.nth(0)).toHaveAccessibleName("Evening digest");
  await morning.getByRole("switch").click();
  await expect(morning.getByRole("switch")).toBeChecked();
  expect(guest.automations.get("a1")?.enabled).toBe(true);

  // Delete asks first.
  await morning.getByRole("button", { name: "Delete Morning fares" }).click();
  const ask = page.getByRole("dialog", { name: "Delete Morning fares?" });
  await expect(ask).toContainText("cannot be undone");
  await ask.getByRole("button", { name: "Keep it" }).click();
  expect(guest.automations.has("a1")).toBe(true);
  await morning.getByRole("button", { name: "Delete Morning fares" }).click();
  await ask.getByRole("button", { name: "Delete automation" }).click();
  // The question closes when the automation is gone (while it is open it hides the page from the role queries).
  await expect(ask).toHaveCount(0);
  await expect(morning).toHaveCount(0);
  expect(guest.automations.has("a1")).toBe(false);
  await expect(cards).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(7);
});

test("what the empty automations say follows the permission", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("memory-automations-deny");
  const read = await harness.api.getDot(dot.id);
  await harness.api.updateDot(dot.id, { ...read.config, permissions: { ...read.config.permissions, automations: "deny" } });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/memory?view=automations`);
  await expect(page.getByText(/cannot set any up/)).toBeVisible();
});

test("a stopped computer says so on both views, and starts from there", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("memory-stopped");
  harness.driver.guestOf(dot.id).putFile("/home/dot/memory/fares.md", "Cheapest in May.");
  await harness.api.stopComputer(dot.id);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/memory`);
  await expect(page.getByRole("status").filter({ hasText: "Start the computer to read its notes" })).toBeVisible();
  // The switch is the control plane's, so it needs no computer.
  await expect(page.getByRole("switch", { name: /Memory is on/ })).toBeEnabled();
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Start the computer to see its automations" })).toBeVisible();
  await page.getByRole("link", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "Start the computer" }).click();
  await expect(page.getByRole("link", { name: /fares\.md/ })).toBeVisible();
});

test("the Memory page fits a phone: no sideways scroll at 390 px, and a note replaces the list", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("memory-phone");
  const guest = harness.driver.guestOf(dot.id);
  const longName = "a-note-with-a-very-long-name-that-has-no-break-in-it-at-all-and-keeps-going-and-going.md";
  guest.putFile(`/home/dot/memory/${longName}`, "# A long title that goes on and on without any break so it must wrap or scroll inside\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  guest.putAutomation(automation("a1", "A schedule named for the thing it does, which is long enough to need a truncation"));
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await page.goto(`${harness.webUrl}/dots/${dot.id}/memory`);
  await expect(page.getByRole("list", { name: "Notes" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("list", { name: "Notes" }).getByRole("link").click();
  await expect(page.getByRole("region", { name: `File ${longName}` })).toBeVisible();
  // On a narrow screen the open note takes the list's place, with a way back.
  await expect(page.getByRole("list", { name: "Notes" })).toBeHidden();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("link", { name: "All notes" }).click();
  await expect(page.getByRole("list", { name: "Notes" })).toBeVisible();

  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(page.getByRole("article")).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the Memory page is readable in ${scheme}: notes, the chip, the switch's text, the schedule card`, async ({ signedIn: page, harness }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await harness.createDot(`memory-look-${scheme}`);
    const guest = harness.driver.guestOf(dot.id);
    guest.putFile("/home/dot/memory/fares.md", "Cheapest in May.", hoursAgo(5));
    await page.goto(`${harness.webUrl}/dots/${dot.id}/memory`);
    await expect(page.getByRole("list", { name: "Notes" })).toBeVisible();
    // A fresh note: the row is tinted and the chip shows.
    guest.putFile("/home/dot/memory/trips/lisbon.md", "Lisbon in June");
    guest.emit("memory.written", { key: "trips/lisbon.md" });
    await expect(page.locator("[data-slot=memory-chips]").getByRole("link")).toBeVisible();

    const notes: Record<string, string> = {
      "the switch's explanation": "section[aria-labelledby=memory-switch-label] p",
      "a note's name": "ul[aria-label=Notes] li:has-text('fares.md') a span.block",
      "a note's time": "ul[aria-label=Notes] li:has-text('fares.md') a span.text-xs",
      "a fresh note's time": "ul[aria-label=Notes] li:has-text('lisbon.md') a span.text-xs",
      "the chip": "[data-slot=memory-chips] a",
      "the chips' header": "[data-slot=memory-chips] > div",
    };
    for (const [name, selector] of Object.entries(notes)) {
      expect((await lookOf(page, selector)).contrast, name).toBeGreaterThanOrEqual(4.5);
    }

    guest.putAutomation(automation("a1", "Morning fares", { last_run_at_ms: Date.now() - 3_600_000, last_status: "error", last_error: "it broke" }));
    guest.putAutomation(automation("a2", "Evening digest", { enabled: false, next_run_at_ms: null, last_run_at_ms: Date.now() - 3_600_000, last_status: "ok" }));
    await page.goto(`${harness.webUrl}/dots/${dot.id}/memory?view=automations`);
    await expect(page.getByRole("article", { name: "Morning fares" })).toBeVisible();
    const schedule: Record<string, string> = {
      "the cadence": "article[aria-label='Morning fares'] p.text-xs",
      "a row's label": "article[aria-label='Morning fares'] dt",
      "the next run": "article[aria-label='Morning fares'] dd",
      "a failed run": "article[aria-label='Morning fares'] dd span.font-medium",
      "its error": "article[aria-label='Morning fares'] dd p",
      "what the Dot is told": "article[aria-label='Morning fares'] p.line-clamp-3",
      "a paused card's next run": "article[aria-label='Evening digest'] dd",
      "a successful run": "article[aria-label='Evening digest'] dd span.font-medium",
    };
    for (const [name, selector] of Object.entries(schedule)) {
      expect((await lookOf(page, selector)).contrast, name).toBeGreaterThanOrEqual(4.5);
    }
  });
}
