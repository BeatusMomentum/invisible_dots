import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import type { Harness } from "./harness.js";
import { lookOf } from "./look.js";

/** A token as @BotFather makes them: the bot's id, a colon, a secret. The Bot API of the harness knows the bots a test adds. */
function makeBot(harness: Harness, id: number, username: string): string {
  const token = `${id}:E2E-SECRET-${username.replace(/\W/g, "")}-0123456789`;
  harness.bots.addBot(token, username);
  return token;
}

// The Dots of these tests are marks on every page of the shared host (a channel to link again counts for the Inbox
// and the title), so each test removes its own, and the other specs find the host as they expect.
test.afterEach(async ({ harness }) => {
  for (const dot of await harness.api.listDots()) if (dot.name.startsWith("channels-")) await harness.api.deleteDot(dot.id);
});

const channelsTab = (page: Page) => page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: /^Channels/ });
const telegram = (page: Page) => page.getByRole("region", { name: "Telegram" });
const whatsapp = (page: Page) => page.getByRole("region", { name: "WhatsApp" });

/** The pairing code in the link of a card's "Open ..." button. */
async function codeOf(page: Page, name: "Open Telegram" | "Open WhatsApp"): Promise<string> {
  const href = await page.getByRole("link", { name }).getAttribute("href");
  const code = /(?:start=|pair(?:%20|\+| )?)([A-Z0-9]+)$/.exec(href ?? "")?.[1];
  if (!code) throw new Error(`no pairing code in ${href}`);
  return code;
}

test("the Channels tab connects Telegram, pairs a person with the code, and carries their messages to the chat and the answers back", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("channels-telegram");
  const token = makeBot(harness, 700001, "e2e_fares_bot");
  const ann = { id: 4242, first_name: "Ann" };
  await page.goto(`${harness.webUrl}/dots/${dot.id}/chat`);

  await channelsTab(page).click();
  await expect(page).toHaveURL(/\/channels$/);
  await expect(page.getByRole("heading", { level: 1, name: "channels-telegram" })).toBeVisible();
  await expect(telegram(page).getByText("Not connected")).toBeVisible();

  // The token is checked with Telegram and then forgotten by the page.
  await telegram(page).getByLabel("Bot token").fill(token);
  await telegram(page).getByRole("button", { name: "Connect Telegram" }).click();
  await expect(telegram(page).getByText("Connected")).toBeVisible();
  await expect(telegram(page).getByRole("link", { name: "@e2e_fares_bot" })).toHaveAttribute("href", "https://t.me/e2e_fares_bot");
  await expect(page.locator("body")).not.toContainText("E2E-SECRET");
  await expect(page.getByLabel("Bot token")).toHaveCount(0);
  expect(JSON.stringify(await harness.api.channels(dot.id))).not.toContain("E2E-SECRET");

  // Link: the deep link, its QR code and the words to type, with the code counting down.
  await telegram(page).getByRole("button", { name: "Link your Telegram" }).click();
  const open = telegram(page).getByRole("link", { name: "Open Telegram" });
  await expect(open).toHaveAttribute("href", /^https:\/\/t\.me\/e2e_fares_bot\?start=[A-Z0-9]+$/);
  await expect(telegram(page).getByRole("img", { name: "QR code that opens Telegram with the pairing code" })).toBeVisible();
  await expect(telegram(page).getByRole("timer")).toHaveText(/^Expires in (10:00|9:\d\d)\.$/);
  const code = await codeOf(page, "Open Telegram");
  await expect(telegram(page).getByText(`/start ${code}`)).toBeVisible();

  // A stranger who writes first is not paired and not answered; the person who sends the code is.
  harness.bots.say(token, "hello?", { id: 999, first_name: "Stranger" });
  harness.bots.say(token, `/start ${code}`, ann);
  const people = telegram(page).getByRole("region", { name: "People paired on Telegram" });
  await expect(people.getByRole("listitem")).toHaveCount(1);
  await expect(people.getByRole("listitem")).toContainText("Ann");
  await expect(people.getByRole("listitem")).toContainText("Owner");
  await expect(telegram(page).getByText(`/start ${code}`)).toHaveCount(0);
  await expect(page.getByText("Ann is paired on Telegram.")).toBeVisible();
  expect(harness.bots.sent(token, 999)).toEqual([]);

  // What Ann writes arrives in the chat with where it came from; the Dot's answer goes back to her chat.
  harness.bots.say(token, "Is the 9 am flight still the cheapest?", ann);
  await page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: "Chat" }).click();
  const bubble = page.getByRole("article", { name: "You" }).filter({ hasText: "Is the 9 am flight still the cheapest?" });
  await expect(bubble.getByText("via Telegram")).toBeVisible();
  await expect(page.getByRole("log").getByRole("article", { name: "channels-telegram" }).getByText("echo: Is the 9 am flight still the cheapest?")).toBeVisible();
  await expect.poll(() => harness.bots.sent(token, 4242).map((message) => message.text)).toContain("echo: Is the 9 am flight still the cheapest?");

  // The same message is in the Activity log with its chip.
  await page.goto(`${harness.webUrl}/dots/${dot.id}/activity`);
  await expect(page.getByRole("list", { name: "Events" }).getByRole("listitem").filter({ hasText: "via Telegram" })).toBeVisible();
});

test("the switches of a channel are saved and kept, a person is revoked and Telegram is disconnected, each after asking where it is final", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("channels-settings");
  const token = makeBot(harness, 700002, "e2e_settings_bot");
  await harness.api.putTelegramChannel(dot.id, token);
  const code = (await harness.api.pairChannel(dot.id, "telegram")).code;
  harness.bots.say(token, `/start ${code}`, { id: 5151, first_name: "Bea" });
  await expect.poll(async () => (await harness.api.channels(dot.id))[0]?.peers.length).toBe(1);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/channels`);

  const show = telegram(page).getByRole("switch", { name: "Show what the Dot wants to run" });
  // A new channel has everything on.
  await expect(show).toHaveAttribute("aria-checked", "true");
  await show.click();
  await expect(show).toHaveAttribute("aria-checked", "false");
  await telegram(page).getByRole("switch", { name: "Tell me when a task ends" }).click();
  await expect(telegram(page).getByRole("switch", { name: "Tell me when a task ends" })).toHaveAttribute("aria-checked", "false");
  expect((await harness.api.channels(dot.id))[0]!.settings).toEqual({ approvals: true, notify_tasks: false, show_arguments: false });
  // Kept: the host has them, so a reload shows them.
  await page.reload();
  await expect(telegram(page).getByRole("switch", { name: "Show what the Dot wants to run" })).toHaveAttribute("aria-checked", "false");
  await expect(telegram(page).getByRole("switch", { name: "Tell me when a task ends" })).toHaveAttribute("aria-checked", "false");

  await telegram(page).getByRole("button", { name: "Pause" }).click();
  await expect(telegram(page).getByText("Paused")).toBeVisible();
  await telegram(page).getByRole("button", { name: "Resume" }).click();
  await expect(telegram(page).getByText("Connected")).toBeVisible();

  // Revoked: the host drops her, and the bot no longer answers her.
  await telegram(page).getByRole("button", { name: "Revoke Bea" }).click();
  await page.getByRole("dialog", { name: "Revoke Bea?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(telegram(page).getByText(/Nobody yet/)).toBeVisible();
  expect((await harness.api.channels(dot.id))[0]!.peers).toEqual([]);

  await telegram(page).getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("dialog", { name: "Disconnect Telegram?" })).toBeVisible();
  expect(await harness.api.channels(dot.id)).toHaveLength(1);
  await page.getByRole("dialog", { name: "Disconnect Telegram?" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(telegram(page).getByLabel("Bot token")).toBeVisible();
  expect(await harness.api.channels(dot.id)).toEqual([]);
});

// The Inbox counts what needs the person across every Dot, so this test has a host of its own (`fresh`) and leaves it
// empty, as the Inbox's own tests expect to find it.
test.describe("a channel that has to be linked again", () => {
  test.afterEach(async ({ fresh }) => {
    for (const dot of await fresh.api.listDots()) await fresh.api.deleteDot(dot.id);
    await expect.poll(async () => (await fresh.api.listDots()).length).toBe(0);
  });

  test("a Telegram token that was revoked puts the Dot in the rail, the tab and the Inbox, and a new token clears them", async ({ signedInFresh: page, fresh: harness }) => {
    const dot = await harness.createDot("channels-relink");
    const token = makeBot(harness, 700003, "e2e_relink_bot");
    const next = makeBot(harness, 700004, "e2e_relink_two_bot");
    await harness.api.putTelegramChannel(dot.id, token);
    const code = (await harness.api.pairChannel(dot.id, "telegram")).code;
    harness.bots.say(token, `/start ${code}`, { id: 6161, first_name: "Cy" });
    await expect.poll(async () => (await harness.api.channels(dot.id))[0]?.peers.length).toBe(1);
    await page.goto(`${harness.webUrl}/dots/${dot.id}/channels`);
    await expect(telegram(page).getByText("Connected")).toBeVisible();
    await expect(page.getByLabel("Telegram needs linking again")).toHaveCount(0);

    // Revoked in @BotFather: the next poll is refused, and the page hears it without a reload.
    harness.bots.revoke(token);
    await expect(telegram(page).getByText("Telegram needs a new token")).toBeVisible();
    await expect(telegram(page).getByText("Needs linking again")).toBeVisible();
    // The Dot is marked in the rail and on its Channels tab, and the Inbox counts it.
    await expect(page.getByRole("navigation", { name: "Dots" }).getByLabel("Telegram needs linking again")).toBeVisible();
    await expect(channelsTab(page).getByLabel("needs linking again")).toBeVisible();
    await expect(page.getByRole("link", { name: /^Inbox/ }).getByLabel("1 need you")).toBeVisible();
    await expect(telegram(page).getByRole("listitem").filter({ hasText: "Cy" })).toBeVisible();
    await page.getByRole("link", { name: /^Inbox/ }).click();
    const card = page.getByRole("article", { name: "Telegram of channels-relink needs linking again" });
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: "Open channels" }).click();
    await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/channels$`));

    // A new token: the channel starts again, the person paired stays, and nothing marks the Dot any more.
    await telegram(page).getByLabel("New bot token").fill(next);
    await telegram(page).getByRole("button", { name: "Use this token" }).click();
    await expect(telegram(page).getByText("Connected")).toBeVisible();
    await expect(telegram(page).getByRole("link", { name: "@e2e_relink_two_bot" })).toBeVisible();
    await expect(telegram(page).getByRole("listitem").filter({ hasText: "Cy" })).toBeVisible();
    await expect(page.getByLabel("Telegram needs linking again")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Inbox/ }).getByLabel(/need you/)).toHaveCount(0);
  });
});

test("WhatsApp is linked by scanning the codes the host makes, then pairs a person and carries their messages", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("channels-whatsapp");
  const made = harness.whatsapp.connections.length;
  await page.goto(`${harness.webUrl}/dots/${dot.id}/channels`);

  await expect(whatsapp(page).getByText("Read this before you link a number")).toBeVisible();
  await expect(whatsapp(page).getByText(/can answer by banning the linked number/)).toBeVisible();
  await whatsapp(page).getByRole("button", { name: "Link WhatsApp" }).click();
  await expect.poll(() => harness.whatsapp.connections.length).toBe(made + 1);

  // Each code the host makes is drawn; the next one replaces it.
  const qr = whatsapp(page).getByRole("img", { name: "QR code to link WhatsApp" });
  harness.whatsapp.current.showCode("2@e2e-code-one,AAAA,BBBB");
  await expect(qr).toBeVisible();
  await expect(whatsapp(page).getByText("Scan this code with the phone that has the number")).toBeVisible();
  const first = await qr.locator("path").getAttribute("d");
  harness.whatsapp.current.showCode("2@e2e-code-two,CCCC,DDDD");
  await expect.poll(() => qr.locator("path").getAttribute("d")).not.toBe(first);

  // The phone scanned it.
  harness.whatsapp.current.open("15550001111");
  await expect(whatsapp(page).getByText("People paired")).toBeVisible();
  await expect(whatsapp(page).getByText("Connected")).toBeVisible();
  await expect(whatsapp(page).getByText("+15550001111")).toBeVisible();
  await expect(qr).toHaveCount(0);
  expect((await harness.api.channels(dot.id))[0]).toMatchObject({ kind: "whatsapp", status: "connected", account: "15550001111" });

  // Pair with the words, from a phone; then a message from it reaches the chat and the answer goes back.
  await whatsapp(page).getByRole("button", { name: "Link your WhatsApp" }).click();
  const code = await codeOf(page, "Open WhatsApp");
  await expect(whatsapp(page).getByText(`pair ${code}`)).toBeVisible();
  const phone = "393331112222@s.whatsapp.net";
  harness.whatsapp.current.receive(phone, `pair ${code}`, { senderName: "Dee" });
  const people = whatsapp(page).getByRole("region", { name: "People paired on WhatsApp" });
  await expect(people.getByRole("listitem")).toContainText("Dee");
  harness.whatsapp.current.receive(phone, "Any news on the fares?", { senderName: "Dee" });
  await page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: "Chat" }).click();
  await expect(page.getByRole("article", { name: "You" }).filter({ hasText: "Any news on the fares?" }).getByText("via WhatsApp")).toBeVisible();
  await expect.poll(() => harness.whatsapp.current.texts(phone)).toContain("echo: Any news on the fares?");
});

test("a WhatsApp link that fails says why and starts over", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("channels-whatsapp-failed");
  const made = harness.whatsapp.connections.length;
  await page.goto(`${harness.webUrl}/dots/${dot.id}/channels`);
  await whatsapp(page).getByRole("button", { name: "Link WhatsApp" }).click();
  await expect.poll(() => harness.whatsapp.connections.length).toBe(made + 1);
  harness.whatsapp.current.showCode("2@e2e-failing-code");
  await expect(whatsapp(page).getByRole("img", { name: "QR code to link WhatsApp" })).toBeVisible();

  // The code was not scanned in time: the connection ends before the link did.
  harness.whatsapp.current.end({ reason: "code_expired" });
  await expect(whatsapp(page).getByText("WhatsApp is not linked")).toBeVisible();
  await expect(whatsapp(page).getByText(/the code expired, or the connection dropped, before it was scanned/)).toBeVisible();
  await expect(whatsapp(page).getByRole("img", { name: "QR code to link WhatsApp" })).toHaveCount(0);
  // It is a login only the person can redo: the Dot is marked, and the card offers it.
  await expect(page.getByRole("navigation", { name: "Dots" }).getByLabel("WhatsApp needs linking again")).toBeVisible();

  await whatsapp(page).getByRole("button", { name: "Link again" }).click();
  await expect.poll(() => harness.whatsapp.connections.length).toBe(made + 2);
  harness.whatsapp.current.showCode("2@e2e-second-try");
  await expect(whatsapp(page).getByRole("img", { name: "QR code to link WhatsApp" })).toBeVisible();
  await expect(whatsapp(page).getByText("WhatsApp is not linked")).toHaveCount(0);
});

test("the Channels page fits a phone: no sideways scroll at 390 px, with a pairing code and a long bot name on it", async ({ signedIn: page, harness }) => {
  const dot = await harness.createDot("channels-phone");
  const token = makeBot(harness, 700005, "a_bot_with_a_very_long_name_that_has_no_break_in_it_at_all_bot");
  await harness.api.putTelegramChannel(dot.id, token);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/channels`);
  await telegram(page).getByRole("button", { name: "Link your Telegram" }).click();
  await expect(telegram(page).getByRole("img", { name: /QR code/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the Channels page is readable in ${scheme}: chips, notes, switches' words, links and the countdown`, async ({ signedIn: page, harness }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await harness.createDot(`channels-look-${scheme}`);
    const token = makeBot(harness, scheme === "light" ? 700006 : 700007, `e2e_look_${scheme}_bot`);
    await harness.api.putTelegramChannel(dot.id, token);
    await page.goto(`${harness.webUrl}/dots/${dot.id}/channels`);
    await telegram(page).getByRole("button", { name: "Link your Telegram" }).click();
    await expect(telegram(page).getByRole("timer")).toBeVisible();
    harness.bots.revoke(token);
    await expect(telegram(page).getByText("Telegram needs a new token")).toBeVisible();

    const texts: Record<string, string> = {
      "the state chip": "section[aria-labelledby=channel-telegram] header span:has-text('Needs linking again')",
      "the bot link": "section[aria-labelledby=channel-telegram] header a",
      "the alert's text": "[data-slot=alert-description] p",
      "the hint of the token field": "#telegram-token-hint",
      "the countdown": "[role=timer]",
      "a switch's words": "section[aria-label='What the channel does'] p",
      "the privacy note": "section[aria-labelledby=channel-telegram] p.text-xs:has-text('not end-to-end encrypted')",
      "the Pause button": "button:has-text('Pause')",
      "the open tab": "nav[aria-label='Dot sections'] a[aria-current=page]",
    };
    for (const [name, selector] of Object.entries(texts)) {
      expect((await lookOf(page, selector)).contrast, name).toBeGreaterThanOrEqual(4.5);
    }
  });
}
