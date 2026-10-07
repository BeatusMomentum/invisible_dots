import { PERMISSIONS, resolvePermission } from "@invisible-dots/shared";
import { expect, test } from "./fixtures.js";

test("a Dot is created by the form: its config is what the form showed, and the person lands in its chat", async ({ page, harness }) => {
  await page.goto(`${harness.webUrl}/`);
  await page.getByRole("link", { name: "New Dot" }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole("heading", { name: "Create a Dot" })).toBeVisible();
  // The checks beside the form come from the real control plane, which holds a key in this harness.
  await expect(page.getByRole("region", { name: "Before you create" }).getByText("OpenRouter key: Ready")).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("form-made");
  await page.getByLabel("Instructions").fill("Write findings to fares.csv.");
  await page.getByLabel("Processors", { exact: true }).fill("4");
  await page.getByLabel("Memory, exact value").fill("8");
  await page.getByRole("radio", { name: /Careful/ }).check();
  await page.getByRole("button", { name: "Create Dot" }).click();

  await expect(page).toHaveURL(/\/dots\/[^/]+\/chat$/);
  await expect(page.getByRole("heading", { level: 1, name: "form-made" })).toBeVisible();
  // The rail knows the new Dot without a reload.
  await expect(page.getByRole("navigation", { name: "Dots" }).getByRole("link", { name: /form-made/ })).toBeVisible();

  const stored = await harness.api.getDot("form-made");
  expect(stored.config).toMatchObject({
    name: "form-made",
    instructions: "Write findings to fares.csv.",
    model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
    computer: { cpu: 4, memory: "8gb", disk: "40gb", idle_timeout: "15m" },
    limits: { max_cost_per_task_usd: 1 },
  });
  const decisions = Object.fromEntries(PERMISSIONS.map((permission) => [permission, resolvePermission(stored.config, permission)]));
  expect(decisions["computer.exec"]).toBe("ask");
  expect(decisions["files.write"]).toBe("ask");
  expect(decisions["files.read"]).toBe("allow");
});

test("a Dot is created from YAML, edited in place", async ({ page, harness }) => {
  await page.goto(`${harness.webUrl}/new`);
  await page.getByLabel("Name", { exact: true }).fill("yaml-made");
  await page.getByRole("button", { name: "Advanced YAML" }).click();
  const editor = page.getByRole("textbox", { name: "Configuration (YAML)" });
  await expect(editor).toHaveValue(/name: yaml-made/);
  // Something only the YAML can say.
  await editor.fill((await editor.inputValue()).replace("limits:\n", "limits:\n  max_steps_per_task: 12\n"));
  await expect(page.getByText("The configuration is valid.")).toBeVisible();
  // The form cannot show it, so going back is refused and the text stays.
  await page.getByRole("button", { name: "Form" }).click();
  await expect(page.getByText("The form cannot show this")).toBeVisible();
  await page.getByRole("button", { name: "Create Dot" }).click();

  await expect(page).toHaveURL(/\/dots\/[^/]+\/chat$/);
  const stored = await harness.api.getDot("yaml-made");
  expect(stored.config.limits.max_steps_per_task).toBe(12);
});

test("a name that is not valid, or is taken, is said so at once, and nothing is created", async ({ page, harness }) => {
  await harness.createDot("name-taken");
  await page.goto(`${harness.webUrl}/new`);
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("Not Valid");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText(/lowercase letters, digits and '-'/).first()).toBeVisible();
  await name.fill("name-taken");
  await expect(page.getByText('A Dot named "name-taken" already exists')).toBeVisible();
  await page.getByRole("button", { name: "Create Dot" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "to fix" })).toBeVisible();
  await expect(page).toHaveURL(/\/new$/);
  expect((await harness.api.listDots()).filter((dot) => dot.name === "name-taken")).toHaveLength(1);
});

test("the checks beside the form say what the host lacks and the command that fixes it, and check again on request", async ({ page, harness }) => {
  const missing = { id: "golden-image", label: "golden image", status: "missing", detail: "none in the images folder", fix: "invisible-dots image build" } as const;
  const healthy = harness.host.images;
  harness.host.images = [missing, healthy[1]!];
  try {
    await page.goto(`${harness.webUrl}/new`);
    const panel = page.getByRole("region", { name: "Before you create" });
    await expect(panel.getByText("QEMU: Ready")).toBeVisible();
    await expect(panel.getByText("golden image: Needs attention")).toBeVisible();
    await expect(panel.getByText("invisible-dots image build")).toBeVisible();
    // Fixed on the host: the next check shows it.
    harness.host.images = healthy;
    await panel.getByRole("button", { name: "Check again" }).click();
    await expect(panel.getByText("golden image: Ready")).toBeVisible();
    await expect(panel.getByText("invisible-dots image build")).toHaveCount(0);
  } finally {
    harness.host.images = healthy;
  }
});

test("the Home page shows a card per Dot and the computer's power on it works", async ({ page, harness }) => {
  const dot = await harness.createDot("home-card");
  await page.goto(`${harness.webUrl}/`);
  const card = page.getByRole("article", { name: "home-card" });
  await expect(card.getByText(/goal/i)).toHaveCount(0);
  await expect(card.getByText("test/model")).toBeVisible();
  await expect(card.getByText("$0.00")).toBeVisible();
  await expect(card.getByRole("img", { name: "Ready" })).toBeVisible();

  await card.getByRole("button", { name: /^Computer: Running/ }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Stop" }).click();
  await expect(card.getByRole("button", { name: /^Computer: Stopped/ })).toBeVisible();
  await expect(card.getByRole("img", { name: "Computer stopped" })).toBeVisible();

  await card.getByRole("link", { name: "Open chat" }).click();
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/chat$`));
});

test("a Dot made elsewhere appears on the Home page while it is open", async ({ page, harness }) => {
  await page.goto(`${harness.webUrl}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Dots" })).toBeVisible();
  await harness.createDot("home-live");
  await expect(page.getByRole("article", { name: "home-live" })).toBeVisible();
});

test("Home and the create page fit a phone: no sideways scroll at 390 px", async ({ page, harness }) => {
  // The longest name a Dot may have.
  const name = "phone-card-".padEnd(40, "x");
  await harness.createDot(name);
  await page.setViewportSize({ width: 390, height: 844 });
  const loaded: Record<string, () => Promise<void>> = {
    "/": async () => {
      const card = page.getByRole("article", { name });
      await expect(card).toBeVisible();
      // The name is cut short inside its card: the shell hides what passes the card's edge, so the page alone does
      // not scroll and only the boxes tell.
      const [outer, title] = [(await card.boundingBox())!, (await card.getByRole("heading", { name }).boundingBox())!];
      expect(title.x + title.width, "the name passes the card's right edge").toBeLessThanOrEqual(outer.x + outer.width);
    },
    "/new": () => expect(page.getByRole("region", { name: "Before you create" }).getByText("OpenRouter key: Ready")).toBeVisible(),
  };
  for (const [path, ready] of Object.entries(loaded)) {
    await page.goto(`${harness.webUrl}${path}`);
    await ready();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});
