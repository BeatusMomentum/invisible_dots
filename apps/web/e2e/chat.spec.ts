import type { FakeGuest } from "@invisible-dots/scheduler/testing";
import type { OutboundEventDataMap } from "@invisible-dots/shared";
import { expect, test } from "./fixtures.js";

/** A tool call as the engine reports it once it has ended. */
function called(tool: string, target: string, change: Partial<OutboundEventDataMap["tool.called"]> = {}): OutboundEventDataMap["tool.called"] {
  return { tool, permission: "computer.exec", decision: "allow", ok: true, duration_ms: 120, target, ...change };
}

/** A guest that takes a message up, does some work, and keeps the turn open: the test says when it answers. */
function startTurn(guest: FakeGuest): void {
  guest.onInbound = (event, g) => {
    if (event.type !== "user.message") return;
    g.emit("agent.state", { state: "THINKING" });
    g.emit("tool.called", called("list_dir", "/home/dot/workspace"));
    g.emit("tool.called", called("read_file", "/home/dot/workspace/fares.csv"));
  };
}

test("the person talks to the Dot: the working row follows the turn, the steps sit between the messages, the answer is markdown", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-turn", "Watch the fares to Lisbon");
  const guest = harness.driver.guestOf(dot.id);
  startTurn(guest);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);

  // A Dot nobody has talked to: its goal, and ways to begin that fill the box and do not send.
  await expect(page.getByRole("heading", { name: "Say hello to chat-turn" })).toBeVisible();
  await expect(page.getByText("Its goal: Watch the fares to Lisbon")).toBeVisible();
  const box = page.getByRole("textbox", { name: "Message" });
  await expect(box).toBeFocused();
  await page.getByRole("button", { name: "Tell me what you will do first." }).click();
  await expect(box).toHaveValue("Tell me what you will do first.");
  await box.fill("");

  // Nothing below reloads the page: this marker would not survive it.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 11));

  await box.fill("What is the cheapest fare to Lisbon?");
  await box.press("Enter");
  const log = page.getByRole("log");
  await expect(log.getByRole("article", { name: "You" }).getByText("What is the cheapest fare to Lisbon?")).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Say hello to chat-turn" })).toHaveCount(0);

  // The Dot is mid-turn: its row says so, and names the last thing it did.
  const working = log.getByRole("status").filter({ hasText: "Thinking..." });
  await expect(working).toBeVisible();
  await expect(working).toContainText("Last step: read a file /home/dot/workspace/fares.csv");
  const steps = log.getByRole("list", { name: "What the Dot did" });
  await expect(steps.getByTestId("activity-step")).toHaveText(["Listed a folder/home/dot/workspace", "Read a file/home/dot/workspace/fares.csv"]);

  // A note it saves shows as a chip, in the turn.
  guest.emit("tool.called", called("write_file", "/home/dot/memory/trips/lisbon.md", { permission: "files.write" }));
  guest.emit("memory.written", { key: "trips/lisbon.md" });
  await expect(log.getByText("Remembered")).toBeVisible();
  await expect(log.getByText("trips/lisbon.md", { exact: true })).toBeVisible();

  // A run of more than three calls folds into one line, which opens on a click. The note above broke the run before it.
  for (const target of ["EUR", "TAP", "Ryanair", "easyJet"]) guest.emit("tool.called", called("grep", target));
  await expect(log.getByRole("button", { name: "4 steps" })).toBeVisible();
  await log.getByRole("button", { name: "4 steps" }).click();
  await expect(log.getByRole("list", { name: "Steps" }).getByTestId("activity-step")).toHaveCount(4);

  guest.emit("message.assistant", { text: "The cheapest is **EUR 41** on Tuesday:\n\n```\nTAP 41 EUR\n```\n\n[the source](https://example.com/fares)" });
  guest.emit("agent.state", { state: "IDLE" });
  const answer = log.getByRole("article", { name: "chat-turn" });
  await expect(answer.locator("strong")).toHaveText("EUR 41");
  await expect(answer.locator("pre")).toHaveText("TAP 41 EUR");
  await expect(answer.getByRole("link", { name: "the source" })).toHaveAttribute("href", "https://example.com/fares");
  await expect(answer.getByRole("link", { name: "the source" })).toHaveAttribute("rel", "noreferrer");
  await expect(working).toHaveCount(0);

  // Steps came before the answer, the question before the steps.
  const text = (await log.textContent()) ?? "";
  expect(text.indexOf("What is the cheapest fare")).toBeLessThan(text.indexOf("4 steps"));
  expect(text.indexOf("4 steps")).toBeLessThan(text.indexOf("The cheapest is"));
  expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(11);

  // The conversation comes back as it was on a fresh load: messages from the host, steps from its log.
  await page.reload();
  await expect(page.getByRole("log").getByRole("article", { name: "chat-turn" }).locator("strong")).toHaveText("EUR 41");
  await expect(page.getByRole("log").getByRole("button", { name: "4 steps" })).toBeVisible();
  await expect(page.getByRole("log").getByText("trips/lisbon.md", { exact: true })).toBeVisible();
});

test("a conversation longer than a page opens on its newest messages, and goes back a page at a time", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-long");
  // 60 questions, each answered by the fake guest's echo: 120 messages, one page and a bit.
  for (let i = 0; i < 60; i++) await harness.api.sendMessage(dot.id, `question ${i}`);
  await expect.poll(async () => (await harness.api.messages(dot.id)).length).toBe(120);

  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  const log = page.getByRole("log");
  await expect(log.getByText("echo: question 59", { exact: true })).toBeVisible();
  await expect(log.getByText("question 0", { exact: true })).toHaveCount(0);
  await expect(log.getByRole("article")).toHaveCount(100);

  await page.getByRole("button", { name: "Show earlier messages" }).click();
  await expect(log.getByText("question 0", { exact: true })).toBeVisible();
  await expect(log.getByRole("article")).toHaveCount(120);
  await expect(page.getByRole("button", { name: "Show earlier messages" })).toHaveCount(0);

  // What the Dot says next still shows below, after the page that was read.
  harness.driver.guestOf(dot.id).emit("message.assistant", { text: "one more, live" });
  await expect(log.getByText("one more, live")).toBeVisible();
});

test("an approval the Dot asks for in the chat is a card where it was asked, the person answers it there, and its answer is a receipt", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-approval");
  const guest = harness.driver.guestOf(dot.id);
  await harness.api.sendMessage(dot.id, "please delete the old profile");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  await expect(page.getByRole("log").getByText("please delete the old profile", { exact: true })).toBeVisible();

  guest.requestApproval(undefined);
  const log = page.getByRole("log");
  const card = log.getByRole("article", { name: "Wants to delete a browser identity" });
  await expect(card).toBeVisible();
  await expect(card.getByText("shop-abc123", { exact: true })).toBeVisible();
  // The Dot's header says it waits for the person too, and links to the Inbox filtered to it.
  await expect(page.getByRole("link", { name: "Dot state: Waiting for you" })).toHaveAttribute("href", `/inbox?dot=${dot.id}`);

  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(log.getByText(/^Allowed:/)).toBeVisible();
  await expect(card).toHaveCount(0);
  expect((await harness.api.listApprovals("approved")).map((a) => a.dot_id)).toEqual([dot.id]);
});

test("the computer panel shows the desktop and each open browser, and follows a browser being opened and closed", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-panel");
  const guest = harness.driver.guestOf(dot.id);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  const toggle = page.getByRole("button", { name: "Watch the computer" });
  await expect(page.getByRole("complementary", { name: "Computer" })).toHaveCount(0);

  await toggle.click();
  const panel = page.getByRole("complementary", { name: "Computer" });
  await expect(panel.getByText("The Dot has control. You are watching.")).toBeVisible();
  await expect(panel.getByRole("img", { name: /current picture of the desktop/ })).toHaveAttribute("src", /^blob:/);
  // The thread is still beside it, and the person can still write.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  // A browser opens: it is offered, and picking it reads its frame.
  const identity = await harness.api.createIdentity(dot.id, { name: "shopping" });
  await expect(panel.getByRole("button", { name: "Browser: shopping" })).toHaveCount(0);
  guest.launchIdentity(identity.id);
  await panel.getByRole("button", { name: "Browser: shopping" }).click();
  await expect(panel.getByRole("img", { name: /current picture of the browser "shopping"/ })).toHaveAttribute("src", /^blob:/);
  await expect(panel.getByRole("button", { name: "Browser: shopping" })).toHaveAttribute("aria-pressed", "true");

  // A call of the Dot holds the browser: the picture stays and the panel says why.
  guest.identityBusy = true;
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel.getByText(/using this browser right now/)).toBeVisible();
  await expect(panel.getByRole("img", { name: /browser "shopping"/ })).toBeVisible();
  guest.identityBusy = false;

  // The browser closes: the panel goes back to the desktop and stops offering it.
  await harness.api.closeIdentity(dot.id, identity.id);
  await expect(panel.getByRole("button", { name: "Browser: shopping" })).toHaveCount(0);
  await expect(panel.getByRole("img", { name: /current picture of the desktop/ })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Desktop" })).toHaveAttribute("aria-pressed", "true");

  // The choice to have it open is remembered across a load.
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Computer" })).toBeVisible();
  await toggle.click();
  await expect(page.getByRole("complementary", { name: "Computer" })).toHaveCount(0);
});

test("a stopped computer says so in the panel, and the chat still takes a message", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-stopped");
  await harness.api.stopComputer(dot.id);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  await expect(page.getByRole("button", { name: /^Computer: STOPPED/ })).toBeVisible();
  await page.getByRole("button", { name: "Watch the computer" }).click();
  await expect(page.getByRole("complementary", { name: "Computer" }).getByText(/The computer is stopped/)).toBeVisible();
  await expect(page.getByText(/Sending a message wakes it/)).toBeVisible();
});

test("the chat works from the keyboard and keeps a draft across a reload", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-keys");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  const box = page.getByRole("textbox", { name: "Message" });
  await expect(box).toBeFocused();
  await page.keyboard.type("first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await expect(box).toHaveValue("first line\nsecond line");
  await expect(page.getByRole("log").getByRole("article", { name: "You" })).toHaveCount(0);

  await page.reload();
  await expect(box).toHaveValue("first line\nsecond line");
  await page.keyboard.press("Enter");
  const bubble = page.getByRole("log").getByRole("article", { name: "You" });
  await expect(bubble).toHaveText(/first line\s*second line/);
  await expect(box).toHaveValue("");
  await expect(page.getByRole("log").getByRole("article", { name: "chat-keys" })).toContainText("echo: first line");
  await page.reload();
  await expect(box).toHaveValue("");
});

test("the chat fits a phone: long lines wrap, code scrolls inside its block, and the computer opens as a sheet", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-phone", "A goal long enough to run past the edge of a narrow screen if nothing held it back, word after word");
  const guest = harness.driver.guestOf(dot.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await harness.api.sendMessage(dot.id, "An unbroken line of text that is long enough to wrap on a narrow screen several times over before it ends");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
  await expect(page.getByRole("log").getByRole("article", { name: "You" })).toBeVisible();
  guest.emit("tool.called", called("read_file", "/home/dot/workspace/a/very/long/path/that/goes/on/and/on/and/on/and/on/and/on/and/file.txt"));
  guest.emit("message.assistant", { text: `Here it is:\n\n\`\`\`\n${"x".repeat(200)}\n\`\`\`\n\n| a | b |\n|---|---|\n| ${"y".repeat(120)} | 2 |` });
  await expect(page.getByRole("log").getByRole("article", { name: "chat-phone" }).locator("pre")).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "Watch the computer" }).click();
  const sheet = page.getByRole("dialog", { name: "The Dot's computer" });
  await expect(sheet.getByRole("img", { name: /current picture of the desktop/ })).toHaveAttribute("src", /^blob:/);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("the user's bubble and the Dot's words are readable in light and in dark", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-look");
  await harness.api.sendMessage(dot.id, "hello there");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);
    await expect(page.getByRole("log").getByRole("article", { name: "chat-look" })).toContainText("echo: hello there");
    const ratio = await page.getByRole("log").getByRole("article", { name: "You" }).locator("p").evaluate((element) => {
      const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const rgb = (color: string): number[] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const luminance = (channels: number[]) => {
        const [r = 0, g = 0, b = 0] = channels.map((value) => {
          const s = value / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const style = getComputedStyle(element);
      const [high = 0, low = 0] = [luminance(rgb(style.color)), luminance(rgb(style.backgroundColor))].sort((a, b) => b - a);
      return (high + 0.05) / (low + 0.05);
    });
    expect(ratio, scheme).toBeGreaterThanOrEqual(4.5);
  }
});

test("a Dot opened by its name moves to its id, and the chat hears the Dot live", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-by-name");
  const guest = harness.driver.guestOf(dot.id);
  await page.goto(`${harness.webUrl}/dots/chat-by-name/chat`);
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/chat$`));
  await expect(page.getByRole("heading", { level: 1, name: "chat-by-name" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");

  guest.emit("agent.state", { state: "THINKING" });
  await expect(page.getByRole("log").getByRole("status").filter({ hasText: "Thinking..." })).toBeVisible();
  guest.emit("message.assistant", { text: "Heard on the id." });
  await expect(page.getByRole("log").getByRole("article", { name: "chat-by-name" }).getByText("Heard on the id.")).toBeVisible();
});

test("a message that came through a chat says which one, and one typed here says nothing", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("chat-origin", "Watch the fares to Lisbon");
  const origin = { channel: "telegram", binding_id: "bind_e2e", chat_id: "4242", external_id: "99:1" } as const;
  await harness.control.scheduler.sendMessage(dot.id, "Is the 9 am flight still the cheapest?", origin);
  await harness.control.scheduler.sendMessage(dot.id, "And the one on Friday?");
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);

  const phone = page.getByRole("article", { name: "You" }).filter({ hasText: "Is the 9 am flight still the cheapest?" });
  await expect(phone.getByText("via Telegram")).toBeVisible();
  await expect(page.getByRole("article", { name: "You" }).filter({ hasText: "And the one on Friday?" })).toBeVisible();
  await expect(page.getByText(/^via /)).toHaveCount(1);
});
