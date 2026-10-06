import type { FakeGuest } from "@invisible-dots/scheduler/testing";
import { expect, test } from "./fixtures.js";
import type { Harness } from "./harness.js";

/** A guest that takes a task up and keeps it: the test says what it reports and when it ends. */
function holdTasks(guest: FakeGuest): void {
  guest.onInbound = (event, g) => {
    if (event.type !== "task.created") return;
    g.emit("agent.state", { state: "THINKING" });
    g.emit("task.started", { task_id: event.data.task_id });
  };
}

async function taskNamed(harness: Harness, dotId: string, description: string) {
  const task = (await harness.api.listTasks(dotId)).find((t) => t.description === description);
  if (!task) throw new Error(`no task "${description}"`);
  return task;
}

test("a task is made in the dialog, its progress line follows the Dot live, and it ends in the history with its result", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("tasks-live");
  const guest = harness.driver.guestOf(dot.id);
  holdTasks(guest);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/tasks`);
  await expect(page.getByText("No tasks yet")).toBeVisible();

  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("What should it do?").fill("Find the cheapest fare to Lisbon");
  await dialog.getByRole("radio", { name: "High" }).check();
  await dialog.getByRole("button", { name: "Create task" }).click();

  const card = page.getByRole("article", { name: "Find the cheapest fare to Lisbon" });
  await expect(card).toBeVisible();
  await expect(card.getByText(/Status: Running/)).toBeVisible();
  await expect(card.getByText(/Priority: High/)).toBeVisible();
  const task = await taskNamed(harness, dot.id, "Find the cheapest fare to Lisbon");
  expect(task.priority).toBe(10);
  await expect(card.getByText(/has not reported anything yet/)).toBeVisible();

  // Nothing below reloads the page: this marker would not survive it.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 7));

  guest.emit("task.progress", { task_id: task.id, text: "Reading the first airline's fares", spent_usd: 0.05 });
  await expect(card.getByText("Reading the first airline's fares")).toBeVisible();
  await expect(card.getByText("$0.05")).toBeVisible();
  // The Dot's header says it too, wherever the person is in it.
  await expect(page.getByRole("link", { name: /Reading the first airline's fares/ }).first()).toBeVisible();

  guest.emit("task.progress", { task_id: task.id, text: "Comparing three airlines", spent_usd: 0.11 });
  await expect(card.getByText("Comparing three airlines")).toBeVisible();
  await expect(card.getByText("Reading the first airline's fares")).toHaveCount(0);
  await expect(card.getByText("$0.11")).toBeVisible();

  guest.emit("task.completed", { task_id: task.id, summary: "The cheapest fare is **EUR 41** on Tuesday.", spent_usd: 0.14 });
  guest.emit("agent.state", { state: "IDLE" });
  const history = page.getByRole("region", { name: /^History/ });
  const row = history.getByRole("row", { name: /Find the cheapest fare/ });
  await expect(row.getByText(/Status: Completed/)).toBeVisible();
  await expect(row.getByText("$0.14")).toBeVisible();
  await expect(row.getByText(/The cheapest fare is/)).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("Nothing is running.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(7);

  // The drawer has its own address, and tells the story of the task.
  await row.getByRole("link", { name: "Find the cheapest fare to Lisbon" }).click();
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/tasks/${task.id}$`));
  const drawer = page.getByRole("dialog", { name: "Find the cheapest fare to Lisbon" });
  await expect(drawer.getByRole("region", { name: "Result" }).locator("strong")).toHaveText("EUR 41");
  await expect(drawer.getByText("Reading the first airline's fares")).toBeVisible();
  await expect(drawer.getByText("Comparing three airlines")).toBeVisible();
  await expect(drawer.getByText("Task created")).toBeVisible();
  await expect(drawer.getByText("$0.14")).toBeVisible();

  // Opened by its address on a fresh load, it is the same.
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Find the cheapest fare to Lisbon" }).getByText("Comparing three airlines")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/tasks$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a running task is cancelled after a question, and the history keeps it as cancelled", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("tasks-cancel");
  holdTasks(harness.driver.guestOf(dot.id));
  const created = await harness.api.createTask(dot.id, { description: "Sort the whole archive" });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/tasks`);
  const card = page.getByRole("article", { name: "Sort the whole archive" });
  await expect(card.getByText(/Status: Running/)).toBeVisible();

  await card.getByRole("button", { name: /^Cancel/ }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this task?" });
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await harness.api.getTask(created.id)).status).toBe("RUNNING");

  await card.getByRole("button", { name: /^Cancel/ }).click();
  await page.getByRole("dialog", { name: "Cancel this task?" }).getByRole("button", { name: "Cancel task" }).click();
  const row = page.getByRole("region", { name: /^History/ }).getByRole("row", { name: /Sort the whole archive/ });
  await expect(row.getByText(/Status: Cancelled/)).toBeVisible();
  await expect(row.getByText("cancelled by the user")).toBeVisible();
  await expect(card).toHaveCount(0);
  expect((await harness.api.getTask(created.id)).status).toBe("CANCELLED");
});

test("a task that fails shows the reason as the Dot gave it, in the history and in the drawer", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("tasks-fail");
  const guest = harness.driver.guestOf(dot.id);
  holdTasks(guest);
  const created = await harness.api.createTask(dot.id, { description: "Rebuild the index" });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/tasks`);
  await expect(page.getByRole("article", { name: "Rebuild the index" })).toBeVisible();

  guest.emit("task.failed", { task_id: created.id, error: "the per-task cost cap of $1.00 was reached", spent_usd: 1.02 });
  guest.emit("agent.state", { state: "IDLE" });
  const row = page.getByRole("region", { name: /^History/ }).getByRole("row", { name: /Rebuild the index/ });
  await expect(row.getByText(/Status: Failed/)).toBeVisible();
  await expect(row.getByText("the per-task cost cap of $1.00 was reached")).toBeVisible();
  await expect(row.getByText("$1.02")).toBeVisible();

  await page.getByRole("region", { name: /^History/ }).getByRole("button", { name: "Completed" }).click();
  await expect(page.getByText("No completed tasks.")).toBeVisible();
  await page.getByRole("button", { name: "Failed" }).click();
  await row.getByRole("link", { name: "Rebuild the index" }).click();
  await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: "cost cap of $1.00" })).toBeVisible();
});

test("tasks that wait are in the queue in the order the Dot takes them, and one with a time is scheduled", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("tasks-queue");
  holdTasks(harness.driver.guestOf(dot.id));
  await harness.api.createTask(dot.id, { description: "Occupy the Dot" });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/tasks`);
  await expect(page.getByRole("article", { name: "Occupy the Dot" })).toBeVisible();

  await harness.api.createTask(dot.id, { description: "Tidy up", priority: -10 });
  await harness.api.createTask(dot.id, { description: "Answer the customer", priority: 100 });
  await harness.api.createTask(dot.id, { description: "Weekly report" });
  await harness.api.createTask(dot.id, { description: "Next week's plan", scheduled_at: new Date(Date.now() + 26 * 3_600_000).toISOString() });

  const queue = page.getByRole("region", { name: /^Queue/ });
  await expect(queue.getByRole("article")).toHaveCount(3);
  expect(await queue.getByRole("article").evaluateAll((items) => items.map((i) => i.getAttribute("aria-label")))).toEqual(["Answer the customer", "Weekly report", "Tidy up"]);
  await expect(queue.getByRole("article", { name: "Answer the customer" }).getByText("Next", { exact: true })).toBeVisible();
  await expect(queue.getByRole("article", { name: "Answer the customer" }).getByText(/Priority: Urgent/)).toBeVisible();
  const scheduled = page.getByRole("region", { name: /^Scheduled/ });
  await expect(scheduled.getByRole("article", { name: "Next week's plan" }).getByText(/in 1d/)).toBeVisible();
});

test("the Tasks page and its drawer fit a phone: no sideways scroll at 390 px", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("tasks-phone");
  const guest = harness.driver.guestOf(dot.id);
  holdTasks(guest);
  const long = "Collect every price from the long list of airlines and write them into one very long spreadsheet with a column for each day";
  const created = await harness.api.createTask(dot.id, { description: long });
  await harness.api.createTask(dot.id, { description: "Another one waiting in line behind the first, with words enough to wrap" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/tasks`);
  await expect(page.getByRole("article", { name: long })).toBeVisible();
  guest.emit("task.progress", { task_id: created.id, text: "An unbroken line of progress text that is long enough to wrap on a narrow screen several times over", spent_usd: 0.01 });
  await expect(page.getByText(/An unbroken line of progress/).first()).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  await page.getByRole("link", { name: long }).first().click();
  await expect(page.getByRole("dialog", { name: long })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
