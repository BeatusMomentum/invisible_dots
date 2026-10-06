// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelsView } from "../src/components/channels/ChannelsView";
import { QrCode } from "../src/components/channels/qr-connect";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { Toaster } from "../src/components/ui/sonner";
import { STREAM_LOST } from "../src/lib/channel-link";
import { stubMatchMedia } from "./support/browser";
import { channelRecord, dotRecord, FakeControlPlane } from "./support/control-plane";

vi.mock("next/navigation", () => ({ usePathname: () => "/dots/d1/channels", useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" })];
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The Channels page as the Dot's layout puts it: inside the Dot's shell. */
async function renderChannels() {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId="d1">
          <DotShell dotId="d1">
            <ChannelsView />
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
      <Toaster />
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 1, hidden: true });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
}

const telegram = () => screen.findByRole("region", { name: "Telegram" });
const whatsapp = () => screen.findByRole("region", { name: "WhatsApp" });
const BOT_TOKEN = "123456:SECRET-TOKEN-VALUE";

function withBoth() {
  plane.channelsAvailable = ["telegram", "whatsapp"];
}

describe("connecting Telegram", () => {
  it("asks for the bot's token, sends it once, forgets it, and shows the bot it is connected as", async () => {
    await renderChannels();
    const card = await telegram();
    expect(within(card).getByText("Not connected")).toBeTruthy();
    expect(within(card).getByText(/Telegram bot chats are not end-to-end encrypted/)).toBeTruthy();
    const field = within(card).getByLabelText("Bot token") as HTMLInputElement;
    // A secret is not shown while it is typed.
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");

    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Connect Telegram" }));
    expect(within(card).getByText("Paste the bot's token.")).toBeTruthy();
    expect(plane.channelActions).toEqual([]);

    await user.type(field, BOT_TOKEN);
    await user.click(within(card).getByRole("button", { name: "Connect Telegram" }));
    expect(await within(await telegram()).findByText("Connected")).toBeTruthy();
    expect(plane.sentTokens).toEqual([BOT_TOKEN]);
    expect(plane.channelActions).toEqual(["PUT telegram"]);
    // Nothing on the page holds it any more, and the field is gone with the form.
    expect(screen.queryByLabelText("Bot token")).toBeNull();
    expect(document.body.textContent).not.toContain("SECRET-TOKEN");
    const bot = within(await telegram()).getByRole("link", { name: "@fake_bot" });
    expect(bot.getAttribute("href")).toBe("https://t.me/fake_bot");
    expect(bot.getAttribute("rel")).toBe("noreferrer");
    expect(await screen.findByText("Telegram is connected as @fake_bot.")).toBeTruthy();
  });

  it("says why Telegram was not connected and keeps what was typed, to be corrected", async () => {
    plane.failChannel = { status: 400, error: "invalid_request", message: "Telegram refused this token (401 Unauthorized)" };
    await renderChannels();
    const card = await telegram();
    const user = userEvent.setup();
    await user.type(within(card).getByLabelText("Bot token"), "123:wrong");
    await user.click(within(card).getByRole("button", { name: "Connect Telegram" }));
    expect(await within(card).findByText("Telegram refused this token (401 Unauthorized)")).toBeTruthy();
    expect(within(card).getByText("Telegram was not connected")).toBeTruthy();
    expect((within(card).getByLabelText("Bot token") as HTMLInputElement).value).toBe("123:wrong");
    expect(within(card).getByText("Not connected")).toBeTruthy();
  });

  it("offers WhatsApp only when the server was started with it", async () => {
    await renderChannels();
    await telegram();
    expect(screen.queryByRole("region", { name: "WhatsApp" })).toBeNull();
    cleanup();

    withBoth();
    await renderChannels();
    expect(await whatsapp()).toBeTruthy();
  });

  it("says that a channel that is linked but not offered by this server does nothing, and how to turn it on", async () => {
    plane.channels = { d1: [channelRecord("whatsapp")] };
    await renderChannels();
    const card = await whatsapp();
    expect(within(card).getByText(/linked to this Dot, but this server was started without it/)).toBeTruthy();
    expect(within(card).getByText(/INVISIBLE_DOTS_WHATSAPP=1/)).toBeTruthy();
    expect(within(card).queryByRole("button")).toBeNull();
  });
});

describe("a Telegram channel that is connected", () => {
  beforeEach(() => {
    plane.channels = { d1: [channelRecord("telegram")] };
  });

  it("makes a pairing code, shows it as a link, a QR code and the words to send, and counts it down", async () => {
    await renderChannels();
    const card = await telegram();
    const user = userEvent.setup();
    expect(within(card).queryByText("/start K7M2QX9P")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Link your Telegram" }));
    expect(await within(card).findByText("/start K7M2QX9P")).toBeTruthy();
    expect(plane.channelActions).toEqual(["POST telegram pairing"]);
    const open = within(card).getByRole("link", { name: "Open Telegram" });
    expect(open.getAttribute("href")).toBe("https://t.me/fake_bot?start=K7M2QX9P");
    expect(open.getAttribute("rel")).toBe("noreferrer");
    expect(within(card).getByRole("img", { name: "QR code that opens Telegram with the pairing code" })).toBeTruthy();
    expect(within(card).getByRole("timer").textContent).toMatch(/^Expires in (10:00|9:5\d)\.$/);
  });

  it("says when the code has expired, takes its link and QR away, and makes a new one on request", async () => {
    plane.pairing.expiresInMs = -5_000;
    await renderChannels();
    const card = await telegram();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Link your Telegram" }));
    expect(await within(card).findByText("This code has expired.")).toBeTruthy();
    expect(within(card).queryByRole("link", { name: "Open Telegram" })).toBeNull();
    expect(within(card).queryByRole("img")).toBeNull();

    plane.pairing = { code: "N3W0C0DE", expiresInMs: 600_000 };
    await user.click(within(card).getByRole("button", { name: "New code" }));
    expect(await within(card).findByText("/start N3W0C0DE")).toBeTruthy();
    expect(within(card).queryByText("This code has expired.")).toBeNull();
    expect(within(card).getByRole("link", { name: "Open Telegram" }).getAttribute("href")).toBe("https://t.me/fake_bot?start=N3W0C0DE");
  });

  it("closes the code and lists the person when the host says someone paired", async () => {
    await renderChannels();
    const card = await telegram();
    await userEvent.click(within(card).getByRole("button", { name: "Link your Telegram" }));
    await within(card).findByText("/start K7M2QX9P");
    expect(within(card).getByText(/Nobody yet/)).toBeTruthy();

    plane.channels.d1![0]!.peers = [{ peer_id: "42", role: "owner", label: "Ann", created_at: new Date().toISOString() }];
    act(() => plane.push("d1", "channel.peer.paired", { kind: "telegram", peer_id: "42", label: "Ann" }));
    await waitFor(() => expect(within(card).queryByText("/start K7M2QX9P")).toBeNull());
    expect(await screen.findByText("Ann is paired on Telegram.")).toBeTruthy();
    const people = await within(card).findByRole("list");
    expect(within(people).getByText("Ann", { selector: "p" })).toBeTruthy();
    expect(within(people).getByText("Owner")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Link your Telegram" })).toBeTruthy();
  });

  it("ignores another channel's pairing", async () => {
    withBoth();
    await renderChannels();
    const card = await telegram();
    await userEvent.click(within(card).getByRole("button", { name: "Link your Telegram" }));
    await within(card).findByText("/start K7M2QX9P");
    act(() => plane.push("d1", "channel.peer.paired", { kind: "whatsapp", peer_id: "1", label: "Bob" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(within(card).getByText("/start K7M2QX9P")).toBeTruthy();
  });

  it("lists the people paired, the owner first, and revokes one after asking", async () => {
    plane.channels.d1![0]!.peers = [
      { peer_id: "43", role: "user", label: "Bob", created_at: "2026-01-02T00:00:00Z" },
      { peer_id: "42", role: "owner", label: "Ann", created_at: "2026-01-03T00:00:00Z" },
    ];
    await renderChannels();
    const card = await telegram();
    const rows = within(within(card).getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("AnnOwner"), expect.stringContaining("Bob")]);

    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Revoke Bob" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke Bob?" });
    expect(plane.channelActions).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(within(card).queryByText("Bob", { selector: "p" })).toBeNull());
    expect(plane.channelActions).toEqual(["DELETE telegram peers/43"]);
    expect(within(card).getByText("Ann", { selector: "p" })).toBeTruthy();
    expect(await screen.findByText("Bob is no longer paired.")).toBeTruthy();
  });

  it("warns that revoking the owner leaves nobody to answer approvals there", async () => {
    plane.channels.d1![0]!.peers = [{ peer_id: "42", role: "owner", label: "Ann", created_at: "2026-01-03T00:00:00Z" }];
    await renderChannels();
    const card = await telegram();
    await userEvent.click(within(card).getByRole("button", { name: "Revoke Ann" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke Ann?" });
    expect(within(dialog).getByText(/nobody can answer its approvals there until someone pairs again/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep" }));
    expect(plane.channelActions).toEqual([]);
  });

  it("saves each switch as it is flipped, and shows what the host says it is now", async () => {
    await renderChannels();
    const card = await telegram();
    const switchOf = (name: string) => within(card).getByRole("switch", { name });
    expect(switchOf("Ask for approvals here").getAttribute("aria-checked")).toBe("true");
    expect(switchOf("Show what the Dot wants to run").getAttribute("aria-checked")).toBe("false");

    const user = userEvent.setup();
    await user.click(switchOf("Show what the Dot wants to run"));
    await waitFor(() => expect(switchOf("Show what the Dot wants to run").getAttribute("aria-checked")).toBe("true"));
    await user.click(switchOf("Tell me when a task ends"));
    await waitFor(() => expect(switchOf("Tell me when a task ends").getAttribute("aria-checked")).toBe("false"));
    expect(plane.channelActions).toEqual(['PATCH telegram {"settings":{"show_arguments":true}}', 'PATCH telegram {"settings":{"notify_tasks":false}}']);
    expect(within(card).getByText(/Approve and Reject buttons/)).toBeTruthy();
    expect(within(card).getByText(/cut to 300 characters/)).toBeTruthy();
  });

  it("says when a switch was not saved, and leaves it as the host has it", async () => {
    plane.failChannel = { status: 500, error: "broken", message: "the database is busy" };
    await renderChannels();
    const card = await telegram();
    await userEvent.click(within(card).getByRole("switch", { name: "Show what the Dot wants to run" }));
    expect(await within(card).findByText("the database is busy")).toBeTruthy();
    expect(within(card).getByText('"Show what the Dot wants to run" was not changed')).toBeTruthy();
    expect(within(card).getByRole("switch", { name: "Show what the Dot wants to run" }).getAttribute("aria-checked")).toBe("false");
  });

  it("pauses and resumes the channel", async () => {
    await renderChannels();
    const card = await telegram();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Pause" }));
    expect(await within(card).findByText("Paused")).toBeTruthy();
    expect(plane.channelActions).toEqual(['PATCH telegram {"enabled":false}']);
    await user.click(within(card).getByRole("button", { name: "Resume" }));
    expect(await within(card).findByText("Connected")).toBeTruthy();
    expect(plane.channelActions.at(-1)).toBe('PATCH telegram {"enabled":true}');
  });

  it("stops marking the Dot, its Channels tab and the title once the channel that needed linking is paused or disconnected", async () => {
    document.title = "Channels - invisible_dots";
    Object.assign(plane.channels.d1![0]!, { status: "needs_relink", status_detail: "revoked" });
    await renderChannels();
    const card = await telegram();
    const tab = () => screen.queryByRole("img", { name: "needs linking again" });
    expect(tab()).not.toBeNull();
    await waitFor(() => expect(document.title).toBe("(1) Channels - invisible_dots"));
    const user = userEvent.setup();

    await user.click(within(card).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(tab()).toBeNull());
    await waitFor(() => expect(document.title).toBe("Channels - invisible_dots"));
    await user.click(within(card).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(tab()).not.toBeNull());

    await user.click(within(card).getByRole("button", { name: "Disconnect" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Disconnect Telegram?" })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(tab()).toBeNull());
    await waitFor(() => expect(document.title).toBe("Channels - invisible_dots"));
  });

  it("disconnects only after saying that the token and the people go, and then asks for a token again", async () => {
    await renderChannels();
    const card = await telegram();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Telegram?" });
    expect(within(dialog).getByText(/token is deleted from this machine and every paired person is removed/)).toBeTruthy();
    expect(plane.channelActions).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(await telegram()).findByLabelText("Bot token")).toBeTruthy();
    expect(plane.channelActions).toEqual(["DELETE telegram"]);
    expect(within(await telegram()).getByText("Not connected")).toBeTruthy();
  });

  it("follows the host live: a channel whose token was refused asks for a new one and keeps the people paired", async () => {
    plane.channels.d1![0]!.peers = [{ peer_id: "42", role: "owner", label: "Ann", created_at: "2026-01-03T00:00:00Z" }];
    await renderChannels();
    const card = await telegram();
    expect(within(card).getByText("Connected")).toBeTruthy();
    expect(within(card).queryByLabelText("New bot token")).toBeNull();

    Object.assign(plane.channels.d1![0]!, { status: "needs_relink", status_detail: "Telegram refused the token: it was revoked." });
    act(() => plane.push("d1", "channel.status", { kind: "telegram", status: "needs_relink" }));
    expect(await within(card).findByText("Telegram needs a new token")).toBeTruthy();
    expect(within(card).getByText("Telegram refused the token: it was revoked.")).toBeTruthy();
    expect(within(card).getByText("Needs linking again")).toBeTruthy();
    expect(within(card).getByText("Ann", { selector: "p" })).toBeTruthy();

    const user = userEvent.setup();
    await user.type(within(card).getByLabelText("New bot token"), "123456:NEW-TOKEN");
    await user.click(within(card).getByRole("button", { name: "Use this token" }));
    await waitFor(() => expect(within(card).queryByText("Telegram needs a new token")).toBeNull());
    expect(plane.sentTokens).toEqual(["123456:NEW-TOKEN"]);
    expect(within(card).getByText("Connected")).toBeTruthy();
    expect(within(card).getByText("Ann", { selector: "p" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("NEW-TOKEN");
  });

  it("shows what Telegram reports when the channel has an error", async () => {
    Object.assign(plane.channels.d1![0]!, { status: "error", status_detail: "getUpdates keeps failing: 502" });
    await renderChannels();
    const card = await telegram();
    expect(await within(card).findByText("Telegram has a problem")).toBeTruthy();
    expect(within(card).getByText("getUpdates keeps failing: 502")).toBeTruthy();
    expect(within(card).queryByLabelText("New bot token")).toBeNull();
  });
});

describe("the page itself", () => {
  it("says so when the channels cannot be read, and tries again", async () => {
    plane.failChannels = { status: 502, error: "down", message: "the control plane said no" };
    await renderChannels();
    expect(await screen.findByText("the control plane said no")).toBeTruthy();
    expect(screen.getByText("Could not read the channels")).toBeTruthy();
    plane.failChannels = null;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await telegram()).toBeTruthy();
    expect(screen.queryByText("Could not read the channels")).toBeNull();
  });
});

describe("linking WhatsApp", () => {
  beforeEach(() => {
    withBoth();
    plane.channels = { d1: [channelRecord("telegram")] };
  });

  const qrPath = () => whatsapp().then((card) => within(card).getByRole("img", { name: "QR code to link WhatsApp" }).querySelector("path")!.getAttribute("d"));

  it("warns about the risk before anything is linked", async () => {
    await renderChannels();
    const card = await whatsapp();
    expect(within(card).getByText("Read this before you link a number")).toBeTruthy();
    expect(within(card).getByText(/can answer by banning the linked number/)).toBeTruthy();
    expect(within(card).getByText(/never the one you live on/)).toBeTruthy();
    expect(within(card).getByText("Not connected")).toBeTruthy();
    expect(plane.channelActions).toEqual([]);
  });

  it("starts the link, shows each code the host makes, and ends linked with the number", async () => {
    await renderChannels();
    const card = await whatsapp();
    await userEvent.click(within(card).getByRole("button", { name: "Link WhatsApp" }));
    await waitFor(() => expect(plane.linkOpen("d1")).toBe(true));
    expect(plane.channelActions).toEqual(["POST whatsapp link"]);
    expect(within(card).getByText(/Starting WhatsApp/)).toBeTruthy();

    act(() => plane.linkFrame("d1", { state: "waiting" }));
    expect(within(card).getByText(/Starting WhatsApp/)).toBeTruthy();
    act(() => plane.linkFrame("d1", { state: "code", code: "2@first-code-AAAA,bbbb,cccc" }));
    expect(await within(card).findByText("Scan this code with the phone that has the number")).toBeTruthy();
    expect(within(card).getByText("Go to Settings, then Linked devices, then Link a device.")).toBeTruthy();
    const first = await qrPath();
    expect(first).toBeTruthy();

    // The code is replaced every few seconds: what is shown follows it.
    act(() => plane.linkFrame("d1", { state: "code", code: "2@second-code-DDDD,eeee,ffff" }));
    await waitFor(async () => expect(await qrPath()).not.toBe(first));

    // The phone scanned: the host's record is connected, and its last frame says so.
    Object.assign(plane.channels.d1!.find((c) => c.kind === "whatsapp")!, { status: "connected", account: "15550001111" });
    act(() => plane.linkFrame("d1", { state: "linked", account: "15550001111" }));
    expect(await within(card).findByText("People paired")).toBeTruthy();
    expect(within(card).getByText("Connected")).toBeTruthy();
    expect(within(card).getByText("+15550001111")).toBeTruthy();
    expect(within(card).queryByRole("img", { name: "QR code to link WhatsApp" })).toBeNull();
    expect(await screen.findByText("WhatsApp is linked as +15550001111.")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Unlink" })).toBeTruthy();
    expect(within(card).getByText(/replying yes or no/)).toBeTruthy();
  });

  it("says why the link failed, with the host's words, and starts over on request", async () => {
    await renderChannels();
    const card = await whatsapp();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Link WhatsApp" }));
    await waitFor(() => expect(plane.linkOpen("d1")).toBe(true));
    act(() => plane.linkFrame("d1", { state: "code", code: "2@one" }));
    await within(card).findByRole("img", { name: "QR code to link WhatsApp" });
    act(() => plane.linkFrame("d1", { state: "failed", detail: "The link was not completed: the code expired before it was scanned." }));
    expect(await within(card).findByText("The link was not completed: the code expired before it was scanned.")).toBeTruthy();
    expect(within(card).getByText("WhatsApp is not linked")).toBeTruthy();
    expect(within(card).queryByRole("img", { name: "QR code to link WhatsApp" })).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Link again" }));
    await waitFor(() => expect(plane.linkOpen("d1")).toBe(true));
    expect(plane.channelActions).toEqual(["POST whatsapp link", "POST whatsapp link"]);
    expect(within(card).queryByText("WhatsApp is not linked")).toBeNull();
    act(() => plane.linkFrame("d1", { state: "code", code: "2@again" }));
    expect(await within(card).findByRole("img", { name: "QR code to link WhatsApp" })).toBeTruthy();
  });

  it("says that the connection to the server was lost when the stream ends before the last frame", async () => {
    await renderChannels();
    const card = await whatsapp();
    await userEvent.click(within(card).getByRole("button", { name: "Link WhatsApp" }));
    await waitFor(() => expect(plane.linkOpen("d1")).toBe(true));
    act(() => plane.linkFrame("d1", { state: "code", code: "2@one" }));
    await within(card).findByRole("img", { name: "QR code to link WhatsApp" });
    act(() => plane.dropLink("d1"));
    expect(await within(card).findByText(STREAM_LOST)).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Link again" })).toBeTruthy();
  });

  it("cancels a link in progress by removing the channel the start made", async () => {
    await renderChannels();
    const card = await whatsapp();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Link WhatsApp" }));
    await waitFor(() => expect(plane.linkOpen("d1")).toBe(true));
    act(() => plane.linkFrame("d1", { state: "code", code: "2@one" }));
    await within(card).findByRole("img", { name: "QR code to link WhatsApp" });
    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(await within(card).findByRole("button", { name: "Link WhatsApp" })).toBeTruthy();
    expect(plane.channelActions).toEqual(["POST whatsapp link", "DELETE whatsapp"]);
    expect(plane.channels.d1!.some((c) => c.kind === "whatsapp")).toBe(false);
    expect(within(card).queryByRole("img", { name: "QR code to link WhatsApp" })).toBeNull();
  });

  it("keeps the people paired, and deletes nothing, when a link started with Link again is cancelled", async () => {
    const ann = { peer_id: "42", role: "owner" as const, label: "Ann", created_at: "2026-01-03T00:00:00Z" };
    plane.channels.d1!.push(channelRecord("whatsapp", { status: "needs_relink", status_detail: "WhatsApp unlinked this device.", peers: [ann] }));
    await renderChannels();
    const card = await whatsapp();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Link again" }));
    await waitFor(() => expect(plane.linkOpen("d1")).toBe(true));
    // The host has started the new link: the old account is cleared, the people stay.
    act(() => plane.push("d1", "channel.status", { kind: "whatsapp", status: "connecting" }));
    act(() => plane.linkFrame("d1", { state: "code", code: "2@again" }));
    await within(card).findByRole("img", { name: "QR code to link WhatsApp" });
    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(plane.channelActions).toEqual(["POST whatsapp link", 'PATCH whatsapp {"enabled":false}']));
    expect(plane.channels.d1!.find((c) => c.kind === "whatsapp")?.peers).toEqual([ann]);
    expect(await within(card).findByText("Paused")).toBeTruthy();
    expect(within(card).queryByRole("img", { name: "QR code to link WhatsApp" })).toBeNull();
  });

  it("shows a linked number that is connecting again (a server start, a resume) as linked, with nothing to cancel", async () => {
    plane.channels.d1!.push(channelRecord("whatsapp", { status: "connecting", account: "15550001111", peers: [{ peer_id: "42", role: "owner", label: "Ann", created_at: "2026-01-03T00:00:00Z" }] }));
    await renderChannels();
    const card = await whatsapp();
    expect(await within(card).findByRole("button", { name: "Unlink" })).toBeTruthy();
    expect(within(card).getByText("Connecting")).toBeTruthy();
    expect(within(card).getByText("Ann", { selector: "p" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(within(card).queryByText("Read this before you link a number")).toBeNull();
    expect(within(card).queryByText(/Starting WhatsApp/)).toBeNull();
    expect(plane.linkOpen("d1")).toBe(false);
    expect(plane.channelActions).toEqual([]);
  });

  it("keeps a linked number linked through Pause and Resume, even while it connects again", async () => {
    plane.channels.d1!.push(channelRecord("whatsapp"));
    await renderChannels();
    const card = await whatsapp();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Pause" }));
    expect(await within(card).findByText("Paused")).toBeTruthy();
    expect(within(card).queryByText("Read this before you link a number")).toBeNull();
    // The runner starts again on Resume and reports `connecting` before it is connected.
    plane.channels.d1!.find((c) => c.kind === "whatsapp")!.status = "connecting";
    await user.click(within(card).getByRole("button", { name: "Resume" }));
    expect(await within(card).findByText("Connecting")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(plane.linkOpen("d1")).toBe(false);
    expect(plane.channelActions).toEqual(['PATCH whatsapp {"enabled":false}', 'PATCH whatsapp {"enabled":true}']);
  });

  it("follows a link that was already going on when the page opened, without a click", async () => {
    plane.channels.d1!.push(channelRecord("whatsapp", { status: "connecting", account: null }));
    await renderChannels();
    const card = await whatsapp();
    await waitFor(() => expect(plane.linkOpen("d1")).toBe(true));
    expect(plane.channelActions).toEqual([]);
    expect(within(card).getByText(/Starting WhatsApp/)).toBeTruthy();
    act(() => plane.linkFrame("d1", { state: "code", code: "2@resumed" }));
    expect(await within(card).findByRole("img", { name: "QR code to link WhatsApp" })).toBeTruthy();
  });

  it("shows a link the host says has to be done again, with its reason, before anything is started here", async () => {
    plane.channels.d1!.push(channelRecord("whatsapp", { status: "needs_relink", status_detail: "WhatsApp unlinked this device. Link it again.", account: "15550001111" }));
    await renderChannels();
    const card = await whatsapp();
    expect(await within(card).findByText("WhatsApp unlinked this device. Link it again.")).toBeTruthy();
    expect(within(card).getByText("Needs linking again")).toBeTruthy();
    expect(plane.linkOpen("d1")).toBe(false);
    await userEvent.click(within(card).getByRole("button", { name: "Link again" }));
    await waitFor(() => expect(plane.linkOpen("d1")).toBe(true));
  });

  it("says why linking could not start", async () => {
    plane.failChannel = { status: 409, error: "already_linked", message: "Dot fares is linked to whatsapp already" };
    await renderChannels();
    const card = await whatsapp();
    await userEvent.click(within(card).getByRole("button", { name: "Link WhatsApp" }));
    expect(await within(card).findByText("Dot fares is linked to whatsapp already")).toBeTruthy();
    expect(within(card).getByText("Could not start linking")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Link WhatsApp" })).toBeTruthy();
    expect(plane.linkOpen("d1")).toBe(false);
  });

  it("unlinks a linked number after saying what that does", async () => {
    plane.channels.d1!.push(channelRecord("whatsapp"));
    await renderChannels();
    const card = await whatsapp();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Unlink" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink WhatsApp?" });
    expect(within(dialog).getByText(/Linked devices list on the phone may still show this device/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(await within(card).findByRole("button", { name: "Link WhatsApp" })).toBeTruthy();
    expect(plane.channelActions).toEqual(["DELETE whatsapp"]);
  });

  it("pairs a person with the words WhatsApp is sent, and a link to the number", async () => {
    plane.channels.d1!.push(channelRecord("whatsapp"));
    await renderChannels();
    const card = await whatsapp();
    await userEvent.click(within(card).getByRole("button", { name: "Link your WhatsApp" }));
    expect(await within(card).findByText("pair K7M2QX9P")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Open WhatsApp" }).getAttribute("href")).toBe("https://wa.me/15550001111?text=pair%20K7M2QX9P");
  });
});

describe("the QR code", () => {
  it("is drawn from the text's own modules: the same text gives the same drawing, another text another", () => {
    const { container, rerender } = render(<QrCode text="https://t.me/fake_bot?start=K7M2QX9P" label="code" />);
    const path = () => container.querySelector("path")!.getAttribute("d");
    const first = path();
    rerender(<QrCode text="https://t.me/fake_bot?start=K7M2QX9P" label="code" />);
    expect(path()).toBe(first);
    rerender(<QrCode text="https://t.me/fake_bot?start=OTHERCOD" label="code" />);
    expect(path()).not.toBe(first);
  });

  it("is dark on a light square, whatever the theme, with the quiet zone around it", () => {
    const { container } = render(<QrCode text="A" label="code" />);
    const svg = container.querySelector("svg")!;
    // Version 1 is 21 modules; two blank modules on each side.
    expect(svg.getAttribute("viewBox")).toBe("0 0 25 25");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("code");
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe("#ffffff");
    expect(svg.querySelector("path")!.getAttribute("fill")).toBe("#111827");
    // The three finder squares: the corner module of each is dark.
    const path = svg.querySelector("path")!.getAttribute("d")!;
    for (const corner of ["M2 2h1v1h-1z", "M22 2h1v1h-1z", "M2 22h1v1h-1z"]) expect(path).toContain(corner);
    // The fourth corner has no finder square: its module is light.
    expect(path).not.toContain("M22 22h1v1h-1z");
  });

  it("says so, and draws nothing, when the text is longer than a code can hold", () => {
    const { container } = render(<QrCode text={"x".repeat(5000)} label="code" />);
    expect(screen.getByText("The code could not be drawn.")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });
});
