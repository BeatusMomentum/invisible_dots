import { expect, test } from "./fixtures.js";

test("the Skills tab lists the built-in skills and the Dot's own, opens one as text, and follows one the Dot writes", async ({ page, harness }) => {
  const dot = await harness.createDot("skills-tab");
  const guest = harness.driver.guestOf(dot.id);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  await page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: "Skills" }).click();
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/skills$`));

  const list = page.getByRole("list", { name: "The Dot's skills" });
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list.getByRole("link").first()).toContainText("invisible-playwright");
  await expect(list.getByRole("link").first()).toContainText("Built in");
  await list.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/skills\\?skill=invisible-playwright$`));
  await expect(page.getByRole("region", { name: "The skill invisible-playwright" }).getByRole("heading", { name: "The browser" })).toBeVisible();

  // The Dot writes a skill of its own in a turn: the list has it once the turn ends.
  guest.skills = [
    ...guest.skills,
    { name: "shop-login", description: "Log in to the shop.", source: "dot", path: "/home/dot/skills/shop-login/SKILL.md", content: "---\nname: shop-login\ndescription: Log in to the shop.\n---\n\nClick Sign in.\n" },
  ];
  guest.emit("message.assistant", { text: "I wrote down how to log in." });
  await expect(list.getByRole("link").filter({ hasText: "shop-login" })).toContainText("Written by the Dot");
});

test("a stopped computer says so on the Skills tab, and starts from there", async ({ page, harness }) => {
  const dot = await harness.createDot("skills-stopped");
  await harness.api.stopComputer(dot.id);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/skills`);
  await expect(page.getByRole("status").filter({ hasText: "Start the computer to see its skills" })).toBeVisible();
  await page.getByRole("button", { name: "Start the computer" }).click();
  await expect(page.getByRole("list", { name: "The Dot's skills" })).toBeVisible();
});
