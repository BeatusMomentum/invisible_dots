/**
 * The Telegram adapter against FakeBotApi: the real grammY client over real HTTP, no mocks. The hub's
 * policies are tested with the hub (hub-telegram.test.ts); here is only what the adapter itself decides.
 */
import { waitFor } from "@invisible-dots/scheduler/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelCredentialsError,
  ChannelNeedsRelinkError,
  ChannelSendError,
  TelegramChannelType,
  type ApprovalAction,
  type ChannelSink,
  type ChannelStatusReport,
  type InboundChat,
  type PairingAttempt,
} from "../src/index.js";
import { FakeBotApi } from "../src/testing.js";

const TOKEN = "123456:SECRET-TOKEN-VALUE";
const BINDING = { dot_id: "dot_1" } as never;
const SECRETS = { get: async () => TOKEN };

let api: FakeBotApi;
const stops: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  api = await FakeBotApi.start();
});
afterAll(() => api.close());
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function recorder(inbound?: (m: InboundChat) => Promise<void>, approval: (a: ApprovalAction) => Promise<string> = async () => "Approved.") {
  const seen = { inbound: [] as InboundChat[], pairing: [] as PairingAttempt[], status: [] as ChannelStatusReport[], approvals: [] as ApprovalAction[] };
  const sink: ChannelSink = {
    inbound: async (m) => {
      await inbound?.(m);
      seen.inbound.push(m);
    },
    pairing: async (a) => {
      seen.pairing.push(a);
      return true;
    },
    status: (r) => seen.status.push(r),
    linkCode: () => {},
    approval: async (a) => {
      const notice = await approval(a);
      seen.approvals.push(a);
      return notice;
    },
  };
  return { seen, sink };
}

/** Run an adapter on the fake until the test ends; resolves to its `run` promise's outcome. */
async function running(sink: ChannelSink, options: { pollSeconds?: number } = {}) {
  const type = new TelegramChannelType({ apiRoot: api.apiRoot, ...options });
  const channel = await type.create(BINDING, SECRETS);
  const abort = new AbortController();
  const done = channel.run(sink, abort.signal).then(
    () => ({ ok: true as const }),
    (error: Error) => ({ ok: false as const, error }),
  );
  stops.push(async () => {
    abort.abort();
    await done;
  });
  return { channel, abort, done };
}

const fresh = () => {
  api.addBot(TOKEN, "dot_helper_bot");
};

describe("Telegram adapter", { timeout: 30_000 }, () => {
  it("checks a token before it is stored, and says only words about a bad one", async () => {
    fresh();
    const type = new TelegramChannelType({ apiRoot: api.apiRoot });
    expect(await type.check({ telegram_bot_token: TOKEN })).toEqual({ account: "dot_helper_bot" });

    await expect(type.check({ telegram_bot_token: "999:UNKNOWN-TOKEN-VALUE" })).rejects.toBeInstanceOf(ChannelCredentialsError);
    await expect(type.check({ telegram_bot_token: "not a token" })).rejects.toThrow(/not a Telegram bot token/);
    await expect(type.check({})).rejects.toThrow(/needs the bot token/);
    api.revoke(TOKEN);
    const refused = await type.check({ telegram_bot_token: TOKEN }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(ChannelCredentialsError);
    expect((refused as Error).message).not.toContain(TOKEN);

    fresh();
    api.failNext(TOKEN, "getMe", "drop");
    const unreachable = await type.check({ telegram_bot_token: TOKEN }).catch((e: Error) => e);
    expect(unreachable).not.toBeInstanceOf(ChannelCredentialsError);
    expect((unreachable as Error).message).toMatch(/could not reach Telegram/);
    expect((unreachable as Error).message).not.toContain(TOKEN);
  });

  it("makes the link that opens the bot with the code filled in", () => {
    const type = new TelegramChannelType();
    expect(type.pairingLink("dot_helper_bot", "ABCD2345")).toBe("https://t.me/dot_helper_bot?start=ABCD2345");
    expect(type.pairingLink(null, "ABCD2345")).toBeNull();
  });

  it("reports connected with the bot's name, and removes a webhook the bot had", async () => {
    fresh();
    api.setWebhook(TOKEN, "https://example.test/hook");
    const { sink, seen } = recorder();
    await running(sink);
    await waitFor(() => seen.status.length > 0, "connected");
    expect(seen.status).toEqual([{ status: "connected", account: "dot_helper_bot" }]);
    expect(api.webhook(TOKEN)).toBeNull();
    await waitFor(() => api.polling(TOKEN), "the first poll");
  });

  it("hands a message over with the sender's stable id, the chat and the update's id", async () => {
    fresh();
    const { sink, seen } = recorder();
    await running(sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    const id = api.say(TOKEN, "hello there", { id: 77, first_name: "Ann", username: "ann_x" });
    await waitFor(() => seen.inbound.length === 1, "the message");
    expect(seen.inbound[0]).toEqual({
      externalId: `123456:${id}`,
      peerId: "77",
      chatId: "77",
      text: "hello there",
      direct: true,
      label: "Ann (@ann_x)",
    });
  });

  it("confirms an update to Telegram only after the hub dealt with it, and offers it again when the hub could not", async () => {
    fresh();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { sink, seen } = recorder(() => held);
    const first = await running(sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    const id = api.say(TOKEN, "keep me");
    await waitFor(() => api.polls(TOKEN) >= 1 && api.unconfirmed(TOKEN).includes(id), "the update to be held");
    // While the hub is busy nothing is confirmed: the update is still Telegram's.
    expect(api.unconfirmed(TOKEN)).toEqual([id]);
    release();
    await waitFor(() => seen.inbound.length === 1, "the hub to finish");
    await waitFor(() => api.unconfirmed(TOKEN).length === 0, "the confirmation by the next poll");
    first.abort.abort();
    await first.done;

    // A hub that cannot record the message: the adapter fails, and the update stays for the next run.
    const failing = recorder(async () => {
      throw new Error("the database is down");
    });
    const second = await running(failing.sink);
    await waitFor(() => api.polling(TOKEN), "polling again");
    const kept = api.say(TOKEN, "do not lose me");
    const outcome = await second.done;
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: Error }).error.message).toBe("the database is down");
    expect(api.unconfirmed(TOKEN)).toEqual([kept]);

    const third = recorder();
    await running(third.sink);
    await waitFor(() => third.seen.inbound.length === 1, "the offer again");
    expect(third.seen.inbound[0]).toMatchObject({ text: "do not lose me", externalId: `123456:${kept}` });
  });

  it("takes /start <code> for a pairing attempt, drops a bare /start, and does not pair in a group", async () => {
    fresh();
    const { sink, seen } = recorder();
    await running(sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    api.say(TOKEN, "/start ABCD2345", { id: 5, first_name: "Bo" });
    api.say(TOKEN, "/start", { id: 6 });
    api.say(TOKEN, "/start@dot_helper_bot WXYZ6789", { id: 7, first_name: "Cy" });
    api.say(TOKEN, "/start GROUPCOD", { id: 8 }, { id: -100, type: "supergroup" });
    api.say(TOKEN, "marker", { id: 9 });
    await waitFor(() => seen.inbound.some((m) => m.text === "marker"), "the marker");
    expect(seen.pairing.map((p) => [p.code, p.peerId, p.chatId, p.label])).toEqual([
      ["ABCD2345", "5", "5", "Bo"],
      ["WXYZ6789", "7", "7", "Cy"],
    ]);
    // The code typed in a group reaches the hub as a message of a chat that is not private: it drops it.
    expect(seen.inbound.map((m) => [m.text, m.direct])).toEqual([
      ["/start GROUPCOD", false],
      ["marker", true],
    ]);
  });

  it("marks a message without text as an attachment, and ignores a bot's own messages", async () => {
    fresh();
    const { sink, seen } = recorder();
    await running(sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    api.sendPhoto(TOKEN, { id: 5 }, "look at this");
    api.say(TOKEN, "marker", { id: 5 });
    await waitFor(() => seen.inbound.length === 2, "both");
    expect(seen.inbound[0]).toMatchObject({ attachment: true, text: "look at this" });
    expect(seen.inbound[1]).not.toHaveProperty("attachment");
  });

  it("stops at once when asked, in the middle of a long poll", async () => {
    fresh();
    const { sink } = recorder();
    const { abort, done } = await running(sink, { pollSeconds: 30 });
    await waitFor(() => api.polling(TOKEN), "a long poll");
    const started = Date.now();
    abort.abort();
    expect(await done).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports a second poller as a conflict in words, and a revoked token as one only the person can fix", async () => {
    fresh();
    const first = recorder();
    const one = await running(first.sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    const two = await running(recorder().sink);
    // Telegram ends the older poll: the first adapter is the one that sees the 409.
    const outcome = await one.done;
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: Error }).error.message).toMatch(/another process is polling this bot \(409 Conflict\)/);
    expect((outcome as { error: Error }).error.message).not.toContain(TOKEN);
    two.abort.abort();
    await two.done;

    fresh();
    const third = await running(recorder().sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    api.revoke(TOKEN);
    const revoked = await third.done;
    expect((revoked as { error: Error }).error).toBeInstanceOf(ChannelNeedsRelinkError);
    expect((revoked as { error: Error }).error.message).not.toContain(TOKEN);
  });

  it("sends plain text, and shows typing", async () => {
    fresh();
    const { sink } = recorder();
    const { channel } = await running(sink);
    await channel.sendText("77", "a *plain* <text> message\nwith two lines");
    await channel.typing?.("77");
    expect(api.sent(TOKEN)).toEqual([{ chat_id: "77", text: "a *plain* <text> message\nwith two lines" }]);
    expect(api.actions(TOKEN)).toEqual([{ chat_id: "77", action: "typing" }]);
  });

  it("tells the hub whether sending again can work: not after a block, after a 429 only once the wait is over", async () => {
    fresh();
    const { channel } = await running(recorder().sink);

    api.blockChat(TOKEN, 77);
    const blocked = await channel.sendText("77", "hi").catch((e: Error) => e);
    expect(blocked).toBeInstanceOf(ChannelSendError);
    expect((blocked as ChannelSendError).options).toEqual({ retryable: false });
    expect((blocked as Error).message).toBe("Telegram answered 403 (Forbidden: bot was blocked by the user) to sendMessage");

    api.failNext(TOKEN, "sendMessage", { error_code: 429, description: "x", retry_after: 3 });
    const limited = await channel.sendText("78", "hi").catch((e: Error) => e);
    expect((limited as ChannelSendError).options).toEqual({ retryable: true, retryAfterMs: 3000 });

    api.failNext(TOKEN, "sendMessage", { error_code: 502, description: "Bad Gateway" });
    const flaky = await channel.sendText("78", "hi").catch((e: Error) => e);
    expect(flaky).not.toBeInstanceOf(ChannelSendError);
    expect((flaky as Error).message).toContain("502");

    api.failNext(TOKEN, "sendMessage", "drop");
    const dropped = await channel.sendText("78", "hi").catch((e: Error) => e);
    expect(dropped).not.toBeInstanceOf(ChannelSendError);
    expect((dropped as Error).message).toBe("could not reach Telegram (sendMessage)");
    expect(api.sent(TOKEN, 78)).toEqual([]);
    await channel.sendText("78", "after all");
    expect(api.sent(TOKEN, 78)).toEqual([{ chat_id: "78", text: "after all" }]);
  });

  it("sends an approval prompt with Approve and Reject buttons, and edits it to the outcome with the buttons gone", async () => {
    fresh();
    const { channel } = await running(recorder().sink);
    const ref = await channel.sendApproval("77", { approvalId: "appr_11111111-2222-3333-4444-555555555555", text: "The Dot asks to use exec" });
    const [prompt] = api.prompts(TOKEN, 77);
    expect(String(prompt!.message_id)).toBe(ref);
    expect(prompt!.text).toBe("The Dot asks to use exec");
    expect(prompt!.buttons).toEqual([
      { text: "Approve", data: "ap1:y:appr_11111111-2222-3333-4444-555555555555" },
      { text: "Reject", data: "ap1:n:appr_11111111-2222-3333-4444-555555555555" },
    ]);
    expect(api.sent(TOKEN)).toEqual([]);

    await channel.editApproval("77", ref, "The Dot asks to use exec\n\nApproved.");
    expect(api.prompts(TOKEN, 77)[0]).toMatchObject({ text: "The Dot asks to use exec\n\nApproved.", buttons: [], edits: 1 });
  });

  it("counts an edit with nothing to do as done, and a blocked chat as final", async () => {
    fresh();
    const { channel } = await running(recorder().sink);
    const ref = await channel.sendApproval("77", { approvalId: "appr_x", text: "ask" });
    await channel.editApproval("77", ref, "ask\n\nRejected.");
    // Edited twice to the same words (a crash between the edit and the record): Telegram says "not modified".
    await channel.editApproval("77", ref, "ask\n\nRejected.");
    // The person deleted the chat message, or it is not ours.
    await channel.editApproval("77", "99999", "ask\n\nRejected.");
    expect(api.prompts(TOKEN, 77)[0]!.edits).toBe(1);

    api.blockChat(TOKEN, 78);
    const blocked = await channel.sendApproval("78", { approvalId: "appr_y", text: "ask" }).catch((e: Error) => e);
    expect((blocked as ChannelSendError).options).toEqual({ retryable: false });
    api.failNext(TOKEN, "editMessageText", { error_code: 429, description: "x", retry_after: 2 });
    const limited = await channel.editApproval("77", ref, "ask\n\nApproved.").catch((e: Error) => e);
    expect((limited as ChannelSendError).options).toEqual({ retryable: true, retryAfterMs: 2000 });
  });

  it("refuses an approval id that does not fit a button, for good, and sends nothing", async () => {
    fresh();
    const { channel } = await running(recorder().sink);
    const refused = await channel.sendApproval("77", { approvalId: `appr_${"x".repeat(60)}`, text: "ask" }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(ChannelSendError);
    expect((refused as ChannelSendError).options).toEqual({ retryable: false });
    expect(api.prompts(TOKEN)).toEqual([]);
  });

  it("hands a button press over with who pressed and where, and shows the person the hub's notice", async () => {
    fresh();
    const { sink, seen } = recorder(undefined, async (a) => (a.decision === "approve" ? "Approved." : "Rejected."));
    const { channel } = await running(sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    const ref = await channel.sendApproval("77", { approvalId: "appr_a", text: "ask" });
    const { queryId } = api.press(TOKEN, Number(ref), "ap1:n:appr_a", { id: 77, first_name: "Ann" });
    await waitFor(() => seen.approvals.length === 1, "the press");
    expect(seen.approvals[0]).toEqual({ approvalId: "appr_a", decision: "reject", peerId: "77", chatId: "77", direct: true });
    await waitFor(() => api.answers(TOKEN).length === 1, "the notice");
    expect(api.answers(TOKEN)).toEqual([{ query_id: queryId, text: "Rejected." }]);
  });

  it("does not hand over a press whose data this version did not make, and says the button is out of date", async () => {
    fresh();
    const { sink, seen } = recorder();
    const { channel } = await running(sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    const ref = Number(await channel.sendApproval("77", { approvalId: "appr_a", text: "ask" }));
    const forged = ["ap2:y:appr_a", "ap1:y:", "ap1:x:appr_a", "ap1:y:appr_a:extra", "ap1:y:appr a", `ap1:y:appr_${"a".repeat(80)}`, "y:appr_a", ""];
    for (const data of forged) api.press(TOKEN, ref, data, { id: 77 });
    await waitFor(() => api.answers(TOKEN).length === forged.length, "an answer to each");
    expect(seen.approvals).toEqual([]);
    expect(api.answers(TOKEN).every((a) => a.text === "This button is out of date.")).toBe(true);
  });

  it("goes on when Telegram refuses the notice (the press is too old), and offers a press again when the hub could not take it", async () => {
    fresh();
    let attempts = 0;
    const { sink, seen } = recorder(undefined, async () => {
      if (++attempts === 1) throw new Error("the database is down");
      return "Approved.";
    });
    const first = await running(sink);
    await waitFor(() => api.polling(TOKEN), "polling");
    const ref = Number(await first.channel.sendApproval("77", { approvalId: "appr_a", text: "ask" }));
    const { updateId } = api.press(TOKEN, ref, "ap1:y:appr_a", { id: 77 });
    // The hub failed: the adapter fails (the hub would start it again), and Telegram still holds the press.
    expect(await first.done).toMatchObject({ ok: false });
    expect(api.unconfirmed(TOKEN)).toContain(updateId);

    api.failNext(TOKEN, "answerCallbackQuery", { error_code: 400, description: "query is too old" });
    const pollsBefore = api.polls(TOKEN);
    const second = await running(sink);
    await waitFor(() => seen.approvals.length === 1, "the press, offered again");
    // The poll that carried the press, then the one that confirms it with its offset.
    await waitFor(() => api.polls(TOKEN) >= pollsBefore + 2, "the next poll");
    expect(api.unconfirmed(TOKEN)).toEqual([]);
    expect(api.answers(TOKEN)).toEqual([]);
    second.abort.abort();
  });

  it("refuses to make a channel for a Dot with no token", async () => {
    const type = new TelegramChannelType({ apiRoot: api.apiRoot });
    await expect(type.create(BINDING, { get: async () => null })).rejects.toThrow(/no Telegram bot token/);
  });
});
