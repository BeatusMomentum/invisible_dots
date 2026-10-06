/**
 * The WhatsApp channel on its own, over the fake connection: who a message is from, what it is, what is never
 * answered, how the Dot's words are sent and how a connection that ends is understood. The hub's policies on
 * top of it are in hub-whatsapp.test.ts; the Baileys glue is in baileys.test.ts. Nothing here touches a
 * network: WhatsApp cannot be faked, so the channel runs on `FakeWhatsAppConnector`.
 */
import type { ChannelBindingRecord } from "@invisible-dots/database";
import { waitFor } from "@invisible-dots/scheduler/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelNeedsRelinkError, WhatsAppChannelType, type ApprovalAction, type Channel, type ChannelSink, type ChannelStatusReport, type InboundChat, type PairingAttempt } from "../src/index.js";
import { FakeWhatsAppConnector, type FakeWhatsAppConnection } from "../src/testing.js";

const ANN = "393331112222@s.whatsapp.net";
const ANN_LID = "99887766554433@lid";

const binding = { id: "chb_1", dot_id: "dot_1", kind: "whatsapp", enabled: true, settings: { approvals: true, notify_tasks: true, show_arguments: true }, status: "connecting", status_detail: null, account: null, event_cursor: 0, created_at: "now" } as ChannelBindingRecord;
const noSecrets = { get: async () => null, putAll: async () => {} };

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** The channel running on a fake connection, with a sink that records what it is told. */
async function rig(options: { inbound?: (m: InboundChat) => Promise<void>; pauseMs?: () => number } = {}) {
  const connector = new FakeWhatsAppConnector();
  const type = new WhatsAppChannelType({ connector: () => connector, pauseMs: options.pauseMs ?? (() => 0) });
  const seen = {
    inbound: [] as InboundChat[],
    pairing: [] as PairingAttempt[],
    status: [] as ChannelStatusReport[],
    codes: [] as string[],
    approvals: [] as ApprovalAction[],
  };
  const sink: ChannelSink = {
    inbound: async (m) => {
      await options.inbound?.(m);
      seen.inbound.push(m);
    },
    pairing: async (a) => {
      seen.pairing.push(a);
      return true;
    },
    status: (r) => seen.status.push(r),
    approval: async (a) => {
      seen.approvals.push(a);
      return "ok";
    },
    linkCode: (code) => seen.codes.push(code),
  };
  const abort = new AbortController();
  const channel: Channel = await type.create(binding, noSecrets);
  const outcome = channel.run(sink, abort.signal).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error: error as Error }),
  );
  stops.push(async () => {
    abort.abort();
    await outcome;
  });
  await waitFor(() => connector.connections.length > 0, "the first connection");
  const connection = (): FakeWhatsAppConnection => connector.current;
  connection().open("15550001111");
  await waitFor(() => seen.status.length > 0, "the connected status");
  return { connector, channel, seen, connection, abort, outcome, type };
}

describe("who a message is from", () => {
  it("is the phone number, from the address or from its twin, whichever WhatsApp used", async () => {
    const r = await rig();
    r.connection().receive(ANN, "from the phone address", { senderName: "Ann" });
    r.connection().receive(ANN_LID, "from the LID address", { chatAlt: ANN });
    await waitFor(() => r.seen.inbound.length === 2, "both messages");
    expect(r.seen.inbound.map((m) => [m.peerId, m.chatId, m.text, m.direct])).toEqual([
      ["393331112222", ANN, "from the phone address", true],
      ["393331112222", ANN, "from the LID address", true],
    ]);
    expect(r.seen.inbound[0]!.label).toBe("Ann (+393331112222)");
    expect(r.seen.inbound[1]!.label).toBe("+393331112222");
  });

  it("is the phone number when the account learned the LID's number earlier, and the LID when nobody knows it", async () => {
    const r = await rig();
    r.connector.phonesByLid.set("99887766554433", "393331112222");
    r.connection().receive(ANN_LID, "known");
    r.connection().receive("5544332211009@lid", "unknown", { senderName: "Hidden" });
    await waitFor(() => r.seen.inbound.length === 2, "both messages");
    expect(r.seen.inbound.map((m) => [m.peerId, m.chatId, m.label])).toEqual([
      ["393331112222", ANN, "+393331112222"],
      ["lid:5544332211009", "5544332211009@lid", "Hidden"],
    ]);
  });

  it("ignores device and agent suffixes of an address: they belong to the connection, not to the person", async () => {
    const r = await rig();
    r.connection().receive("393331112222:7@s.whatsapp.net", "from another device");
    await waitFor(() => r.seen.inbound.length === 1, "the message");
    expect(r.seen.inbound[0]).toMatchObject({ peerId: "393331112222", chatId: ANN });
  });

  it("keeps the id of a message under the person, so a redelivery has the same id whichever address it came by", async () => {
    const r = await rig();
    r.connection().receive(ANN, "once", { id: "WAMSG1" });
    r.connection().receive(ANN_LID, "again", { id: "WAMSG1", chatAlt: ANN });
    await waitFor(() => r.seen.inbound.length === 2, "both");
    expect(r.seen.inbound.map((m) => m.externalId)).toEqual(["393331112222:WAMSG1", "393331112222:WAMSG1"]);
  });
});

describe("what is passed on and what is never answered", () => {
  it("passes on a private text and nothing else of a chat: not a group, a list, a channel, an own message or an empty content", async () => {
    const r = await rig();
    r.connection().receive("120363000000000001@g.us", "to a group");
    r.connection().receive("status@broadcast", "a status");
    r.connection().receive("120363000000000002@newsletter", "a channel post");
    r.connection().receive("393331112222@hosted", "a business account");
    r.connection().receive(ANN, "my own words", { fromMe: true });
    r.connection().receive(ANN, { kind: "none" });
    r.connection().receive(ANN, "the one that counts");
    await waitFor(() => r.seen.inbound.length === 1, "the one message");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.seen.inbound.map((m) => m.text)).toEqual(["the one that counts"]);
    expect(r.seen.pairing).toEqual([]);
  });

  it("marks a media message as an attachment with no text, for the hub to answer", async () => {
    const r = await rig();
    r.connection().receive(ANN, { kind: "attachment" });
    await waitFor(() => r.seen.inbound.length === 1, "the message");
    expect(r.seen.inbound[0]).toMatchObject({ text: "", attachment: true, direct: true });
  });

  it("reads exactly 'pair <code>' as a pairing attempt, in any case, and nothing around it", async () => {
    const r = await rig();
    r.connection().receive(ANN, "pair ABCD2345", { senderName: "Ann" });
    r.connection().receive(ANN, "  PAIR abcd2345  ");
    r.connection().receive(ANN, "pair");
    r.connection().receive(ANN, "please pair ABCD2345");
    r.connection().receive(ANN, "pair ABCD2345 now");
    await waitFor(() => r.seen.inbound.length === 3, "the three ordinary messages");
    expect(r.seen.pairing.map((p) => [p.code, p.peerId, p.chatId, p.label])).toEqual([
      ["ABCD2345", "393331112222", ANN, "Ann (+393331112222)"],
      ["abcd2345", "393331112222", ANN, "+393331112222"],
    ]);
    expect(r.seen.inbound.map((m) => m.text)).toEqual(["pair", "please pair ABCD2345", "pair ABCD2345 now"]);
  });

  it("hands messages over one at a time, in the order they arrived", async () => {
    const order: string[] = [];
    const r = await rig({
      inbound: async (m) => {
        order.push(`start ${m.text}`);
        await new Promise((resolve) => setTimeout(resolve, m.text === "first" ? 40 : 1));
        order.push(`end ${m.text}`);
      },
    });
    r.connection().receive(ANN, "first");
    r.connection().receive(ANN, "second");
    await waitFor(() => r.seen.inbound.length === 2, "both");
    expect(order).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("reports the number of the linked account when it connects, and the code to scan while it is not linked", async () => {
    const connector = new FakeWhatsAppConnector();
    const type = new WhatsAppChannelType({ connector: () => connector, pauseMs: () => 0 });
    const codes: string[] = [];
    const statuses: ChannelStatusReport[] = [];
    const abort = new AbortController();
    const channel = await type.create(binding, noSecrets);
    const done = channel.run({ inbound: async () => {}, pairing: async () => false, approval: async () => "", status: (r) => statuses.push(r), linkCode: (c) => codes.push(c) }, abort.signal);
    await waitFor(() => connector.connections.length === 1, "the connection");
    connector.current.showCode("2@first");
    connector.current.showCode("2@second");
    connector.current.open("15550001111");
    expect(codes).toEqual(["2@first", "2@second"]);
    expect(statuses).toEqual([{ status: "connected", account: "15550001111" }]);
    abort.abort();
    await done;
    expect(connector.current.closed).toBe(true);
  });
});

describe("what is sent", () => {
  it("reads what the chat wrote, shows typing, waits, and only then sends; a chat that wrote nothing gets no read receipt", async () => {
    const pauses: number[] = [];
    const r = await rig({ pauseMs: () => (pauses.push(1), 0) });
    r.connection().receive(ANN, "hello", { id: "WA1" });
    r.connection().receive("111222333444@s.whatsapp.net", "from a stranger", { id: "WA2" });
    await waitFor(() => r.seen.inbound.length === 2, "both");

    await r.channel.sendText(ANN, "an answer");
    expect(r.connection().reads).toEqual([{ chat: ANN, id: "WA1" }]);
    expect(r.connection().typings).toEqual([ANN]);
    expect(r.connection().sent.map((m) => [m.chat, m.text])).toEqual([[ANN, "an answer"]]);
    expect(pauses).toHaveLength(1);

    // The receipt was given once; the stranger's message was never marked read, because nothing was sent to the stranger.
    await r.channel.sendText(ANN, "a second answer");
    expect(r.connection().reads).toHaveLength(1);
    expect(r.connection().reads.map((read) => read.id)).not.toContain("WA2");
  });

  it("remembers the unread message of a bounded number of chats: strangers cannot make it grow without end", async () => {
    const r = await rig();
    for (let i = 0; i < 600; i++) r.connection().receive(`3933300000${String(i).padStart(3, "0")}@s.whatsapp.net`, "hi", { id: `WA${i}` });
    await waitFor(() => r.seen.inbound.length === 600, "all messages");
    await r.channel.sendText("3933300000000@s.whatsapp.net", "to the oldest");
    await r.channel.sendText("3933300000599@s.whatsapp.net", "to the newest");
    expect(r.connection().reads).toEqual([{ chat: "3933300000599@s.whatsapp.net", id: "WA599" }]);
  });

  it("sends an approval prompt with the words that answer it, and edits a prompt in place", async () => {
    const r = await rig();
    const id = await r.channel.sendApproval(ANN, { approvalId: "apr_01k6h3w2ze8m4qv7r1xk9bntc5", text: "The Dot asks to use exec." });
    expect(r.connection().sent[0]!.text).toBe('The Dot asks to use exec.\n\nReply "yes ap-9bntc5" to approve or "no ap-9bntc5" to reject.');
    expect(id).toBe(r.connection().sent[0]!.id);
    await r.channel.editApproval(ANN, id, "The Dot asks to use exec.\n\nApproved.");
    expect(r.connection().edits).toEqual([{ chat: ANN, id, text: "The Dot asks to use exec.\n\nApproved." }]);
  });

  it("says it has no buttons: the hub reads a text answer", async () => {
    const r = await rig();
    expect(r.channel.capabilities).toMatchObject({ approvalByText: true, typing: true, maxText: 4000 });
  });

  it("fails a send while it is not connected, so the hub tries again", async () => {
    const r = await rig();
    r.abort.abort();
    await r.outcome;
    await expect(r.channel.sendText(ANN, "late")).rejects.toThrow(/not connected/);
    await expect(r.channel.typing?.(ANN)).rejects.toThrow(/not connected/);
  });
});

describe("how a connection ends", () => {
  const failureOf = async (end: Parameters<FakeWhatsAppConnection["end"]>[0]) => {
    const r = await rig();
    r.connection().end(end);
    const outcome = await r.outcome;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    return { error: outcome.error, r };
  };

  it("needs the person when the device was removed, was rejected, or was never linked before the code ran out", async () => {
    for (const reason of ["logged_out", "rejected", "code_expired"] as const) {
      const { error } = await failureOf({ reason });
      expect(error).toBeInstanceOf(ChannelNeedsRelinkError);
    }
    expect((await failureOf({ reason: "logged_out" })).error.message).toMatch(/Linked devices/);
    expect((await failureOf({ reason: "rejected" })).error.message).toMatch(/restricted or banned/);
    expect((await failureOf({ reason: "code_expired" })).error.message).toMatch(/Start linking again/);
  });

  it("is an ordinary failure, for the hub to retry, when the connection was lost or another session took over", async () => {
    const lost = await failureOf({ reason: "lost", detail: "Connection Closed (428)" });
    expect(lost.error).not.toBeInstanceOf(ChannelNeedsRelinkError);
    expect(lost.error.message).toBe("the connection to WhatsApp was lost: Connection Closed (428)");
    const replaced = await failureOf({ reason: "replaced" });
    expect(replaced.error).not.toBeInstanceOf(ChannelNeedsRelinkError);
    expect(replaced.error.message).toMatch(/took over/);
    expect(lost.r.connector.current.closed).toBe(true);
  });

  it("opens a new connection when WhatsApp asks for one, as it does when a link finishes, without calling it a failure", async () => {
    const r = await rig();
    r.connection().end({ reason: "restart" });
    await waitFor(() => r.connector.connections.length === 2, "the second connection");
    expect(r.connector.connections[0]!.closed).toBe(true);
    r.connection().open("15550001111");
    r.connection().receive(ANN, "after the restart");
    await waitFor(() => r.seen.inbound.length === 1, "a message on the new connection");
    expect(r.seen.status.every((s) => s.status === "connected")).toBe(true);
  });

  it("gives up when WhatsApp keeps asking for a new connection and none of them opens", async () => {
    const r = await rig();
    r.connection().end({ reason: "restart" });
    for (let i = 2; i <= 4; i++) {
      await waitFor(() => r.connector.connections.length === i, `connection ${i}`);
      r.connection().end({ reason: "restart" });
    }
    const outcome = await r.outcome;
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: Error }).error.message).toMatch(/keeps asking for a new connection/);
  });

  it("fails, and hangs up, when the hub could not take a message: WhatsApp has confirmed it, so the person writes again", async () => {
    const r = await rig({
      inbound: async (m) => {
        if (m.text === "boom") throw new Error("the database is gone");
      },
    });
    r.connection().receive(ANN, "boom");
    const outcome = await r.outcome;
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: Error }).error.message).toBe("could not hand a WhatsApp message to the hub: the database is gone");
    expect(r.connection().closed).toBe(true);
  });

  it("fails when the connection cannot even be opened", async () => {
    const connector = new FakeWhatsAppConnector();
    connector.connectFailure = new Error("cannot load the WhatsApp library");
    const type = new WhatsAppChannelType({ connector: () => connector });
    const channel = await type.create(binding, noSecrets);
    await expect(channel.run({ inbound: async () => {}, pairing: async () => false, approval: async () => "", status: () => {}, linkCode: () => {} }, new AbortController().signal)).rejects.toThrow(
      /cannot load the WhatsApp library/,
    );
  });
});

describe("the channel type", () => {
  const type = new WhatsAppChannelType();

  it("is a scanned channel with no credential a person gives, and names every secret its linked device keeps", () => {
    expect(type.kind).toBe("whatsapp");
    expect(type.scanned).toBe(true);
    expect(type.scrubNames).toEqual([]);
    expect(type.secretNames).toContain("whatsapp_creds");
    expect(type.secretNames).toHaveLength(11);
    expect(new Set(type.secretNames).size).toBe(11);
  });

  it("links the account's chat with the words of the pairing ready to send", () => {
    expect(type.pairingLink("15550001111", "ABCD2345")).toBe("https://wa.me/15550001111?text=pair%20ABCD2345");
    expect(type.pairingLink(null, "ABCD2345")).toBeNull();
    expect(type.pairingMessage("ABCD2345")).toBe("pair ABCD2345");
  });
});
