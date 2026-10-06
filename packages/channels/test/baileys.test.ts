/**
 * The Baileys glue. WhatsApp itself cannot be reached from a test, so what is proved here is what the glue
 * decides on its own: how a Baileys message is read (`toIncoming`, over messages built with Baileys' own
 * protobuf classes and passed through its encoder and decoder, so they are the library's objects and not
 * hand-made look-alikes), how a closed connection is understood (`endOf`), and that the connector survives
 * a socket that cannot connect. The real network is not tested in CI.
 */
import type { WAMessage } from "baileys";
import { describe, expect, it } from "vitest";
import { BaileysConnection, BaileysConnector, endOf, textContent, toIncoming } from "../src/whatsapp-baileys/baileys.js";
import { isDirectJid, lidOf, phoneOf } from "../src/whatsapp-baileys/jid.js";
import type { WhatsAppEnd, WhatsAppEvents, WhatsAppIncoming } from "../src/whatsapp-baileys/port.js";

type Baileys = typeof import("baileys");
const baileys = import("baileys");

/** A message as Baileys hands it over: the protobuf part through the real encoder and decoder, the address extras Baileys adds to the key on top. */
async function received(spec: { key: Record<string, unknown>; message?: Record<string, unknown>; pushName?: string }): Promise<WAMessage> {
  const lib: Baileys = await baileys;
  const info = lib.proto.WebMessageInfo.create({ key: { remoteJid: spec.key.remoteJid as string, id: spec.key.id as string, fromMe: spec.key.fromMe === true }, message: spec.message, pushName: spec.pushName });
  const decoded = lib.proto.WebMessageInfo.decode(lib.proto.WebMessageInfo.encode(info).finish()) as WAMessage;
  Object.assign(decoded.key, spec.key);
  return decoded;
}

const read = async (spec: Parameters<typeof received>[0]): Promise<WhatsAppIncoming | null> => toIncoming(await received(spec), await baileys);

describe("reading a Baileys message", () => {
  it("reads the text of a plain message, and of one that was written as extended text", async () => {
    expect(await read({ key: { remoteJid: "393331112222@s.whatsapp.net", id: "A1" }, message: { conversation: "hello" }, pushName: "Ann" })).toEqual({
      id: "A1",
      chat: "393331112222@s.whatsapp.net",
      fromMe: false,
      senderName: "Ann",
      content: { kind: "text", text: "hello" },
    });
    expect((await read({ key: { remoteJid: "393331112222@s.whatsapp.net", id: "A2" }, message: { extendedTextMessage: { text: "a link https://example.com" } } }))?.content).toEqual({
      kind: "text",
      text: "a link https://example.com",
    });
  });

  it("keeps the other address of a chat that Baileys found: a LID chat with the phone beside it", async () => {
    const incoming = await read({
      key: { remoteJid: "99887766554433@lid", remoteJidAlt: "393331112222@s.whatsapp.net", addressingMode: "lid", id: "A3" },
      message: { conversation: "from a LID" },
    });
    expect(incoming).toMatchObject({ chat: "99887766554433@lid", chatAlt: "393331112222@s.whatsapp.net", content: { kind: "text", text: "from a LID" } });
  });

  it("reads through the wrappers WhatsApp puts around a message: disappearing, view once", async () => {
    expect((await read({ key: { remoteJid: "393331112222@s.whatsapp.net", id: "B1" }, message: { ephemeralMessage: { message: { conversation: "this will disappear" } } } }))?.content).toEqual({
      kind: "text",
      text: "this will disappear",
    });
    expect((await read({ key: { remoteJid: "393331112222@s.whatsapp.net", id: "B2" }, message: { viewOnceMessage: { message: { imageMessage: { mimetype: "image/jpeg" } } } } }))?.content).toEqual({ kind: "attachment" });
  });

  it("calls media, contacts and places attachments, and reactions and protocol messages nothing", async () => {
    const chat = { remoteJid: "393331112222@s.whatsapp.net" };
    const kinds = async (message: Record<string, unknown>, id: string) => (await read({ key: { ...chat, id }, message }))?.content.kind;
    expect(await kinds({ imageMessage: { mimetype: "image/jpeg" } }, "C1")).toBe("attachment");
    expect(await kinds({ audioMessage: { mimetype: "audio/ogg", ptt: true } }, "C2")).toBe("attachment");
    expect(await kinds({ documentMessage: { fileName: "a.pdf" } }, "C3")).toBe("attachment");
    expect(await kinds({ stickerMessage: {} }, "C4")).toBe("attachment");
    expect(await kinds({ locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }, "C5")).toBe("attachment");
    expect(await kinds({ contactMessage: { displayName: "Bob" } }, "C6")).toBe("attachment");
    expect(await kinds({ reactionMessage: { text: "ok" } }, "C7")).toBe("none");
    expect(await kinds({ protocolMessage: { type: 0 } }, "C8")).toBe("none");
    expect(await kinds({ senderKeyDistributionMessage: { groupId: "g" } }, "C9")).toBe("none");
  });

  it("marks what the account wrote itself, and skips a message that has no id or no chat: nobody could answer it", async () => {
    expect((await read({ key: { remoteJid: "393331112222@s.whatsapp.net", id: "D1", fromMe: true }, message: { conversation: "mine" } }))?.fromMe).toBe(true);
    const lib = await baileys;
    expect(toIncoming({ key: { remoteJid: "393331112222@s.whatsapp.net" }, message: { conversation: "no id" } } as WAMessage, lib)).toBeNull();
    expect(toIncoming({ key: { id: "E1" }, message: { conversation: "no chat" } } as WAMessage, lib)).toBeNull();
    expect(toIncoming({ key: { remoteJid: "393331112222@s.whatsapp.net", id: "E2" } } as WAMessage, lib)?.content).toEqual({ kind: "none" });
  });
});

describe("what is sent", () => {
  /** Baileys' own content builder, with a `getUrlInfo` that records the links it was asked to preview (the real one fetches them, from this machine). */
  async function previewed(content: { text: string; linkPreview?: null }): Promise<string[]> {
    const lib: Baileys = await baileys;
    const fetched: string[] = [];
    const getUrlInfo = async (url: string) => {
      fetched.push(url);
      return undefined;
    };
    await lib.generateWAMessageContent(content, { getUrlInfo, upload: async () => ({}) as never } as never);
    return fetched;
  }

  it("never has Baileys fetch a link of a text: an approval prompt or a Dot's message is not requested from here", async () => {
    const text = "The Dot asks to open https://example.com/search?q=the+secret";
    expect(await previewed(textContent(text))).toEqual([]);
    // Without the setting, the same text is fetched by the library: the check above can fail.
    expect(await previewed({ text })).toEqual(["https://example.com/search?q=the+secret"]);
  });

  it("is sent, and edited, with the preview off", async () => {
    const calls: unknown[][] = [];
    const socket = {
      sendMessage: async (...args: unknown[]) => {
        calls.push(args);
        return { key: { id: "WA1" } };
      },
    };
    const connection = new BaileysConnection(socket as never, {} as never, () => {});
    expect(await connection.sendText("393331112222@s.whatsapp.net", "open https://example.com/?q=1")).toBe("WA1");
    await connection.editText("393331112222@s.whatsapp.net", "WA1", "opened https://example.com/?q=1");
    expect(calls).toEqual([
      ["393331112222@s.whatsapp.net", { text: "open https://example.com/?q=1", linkPreview: null }],
      ["393331112222@s.whatsapp.net", { text: "opened https://example.com/?q=1", linkPreview: null, edit: { remoteJid: "393331112222@s.whatsapp.net", id: "WA1", fromMe: true } }],
    ]);
  });
});

describe("how a closed connection is understood", () => {
  const boom = (statusCode: number, message = "closed") => ({ message, output: { statusCode } });
  const table: [string, ReturnType<typeof endOf>][] = [
    ["401 logged out", endOf(boom(401, "Logged Out"), true)],
    ["403 forbidden", endOf(boom(403), true)],
    ["411 multi-device mismatch", endOf(boom(411), true)],
    ["500 bad session", endOf(boom(500), true)],
    ["440 replaced", endOf(boom(440, "Stream Errored (conflict)"), true)],
    ["515 restart required", endOf(boom(515), false)],
  ];

  it("maps the codes that decide what happens next", () => {
    expect(table.map(([, end]) => end.reason)).toEqual(["logged_out", "rejected", "rejected", "rejected", "replaced", "restart"]);
  });

  it("calls a timeout before the device was ever linked an expired code, and after it a lost connection", () => {
    expect(endOf(boom(408, "QR refs attempts ended"), false)).toEqual({ reason: "code_expired" });
    expect(endOf(boom(408, "Connection was lost"), true)).toEqual({ reason: "lost", detail: "Connection was lost (408)" });
  });

  it("says what happened for every other closing, without a stack or an address", () => {
    expect(endOf(boom(428, "Connection Closed"), true)).toEqual({ reason: "lost", detail: "Connection Closed (428)" });
    expect(endOf(boom(503, "Service Unavailable"), true)).toEqual({ reason: "lost", detail: "Service Unavailable (503)" });
    expect(endOf(new Error("connect ECONNREFUSED 127.0.0.1:1"), true)).toEqual({ reason: "lost", detail: "connect ECONNREFUSED 127.0.0.1:1" });
    expect(endOf(undefined, false)).toEqual({ reason: "lost", detail: "the connection closed" });
  });
});

describe("addresses", () => {
  it("tells a phone address, a LID address and everything else apart, and drops the suffixes of a connection", () => {
    expect(phoneOf("393331112222@s.whatsapp.net")).toBe("393331112222");
    expect(phoneOf("393331112222:12@s.whatsapp.net")).toBe("393331112222");
    expect(phoneOf("393331112222_1:12@s.whatsapp.net")).toBe("393331112222");
    expect(phoneOf("99887766554433@lid")).toBeNull();
    expect(lidOf("99887766554433:3@lid")).toBe("99887766554433");
    expect(lidOf("393331112222@s.whatsapp.net")).toBeNull();
    for (const other of ["120363000000000001@g.us", "status@broadcast", "1203@newsletter", "393331112222@hosted", "@s.whatsapp.net", "abc@s.whatsapp.net", "nonsense", "", undefined, null]) {
      expect(isDirectJid(other)).toBe(false);
    }
    expect(isDirectJid("393331112222@s.whatsapp.net")).toBe(true);
    expect(isDirectJid("99887766554433@lid")).toBe(true);
  });
});

describe("the connector on a socket that cannot connect", () => {
  it("loads Baileys, opens the state of a device that is not linked, reports the connection that fails as an end, and closes without writing after", async () => {
    const stored = new Map<string, string>();
    const secrets = {
      get: async (_scope: string, name: string) => stored.get(name) ?? null,
      putAll: async (_scope: string, entries: Readonly<Record<string, string>>) => void Object.entries(entries).forEach(([name, value]) => stored.set(name, value)),
    };
    const ends: WhatsAppEnd[] = [];
    const codes: string[] = [];
    const events: WhatsAppEvents = { code: (c) => codes.push(c), open: () => {}, message: () => {}, end: (e) => ends.push(e) };
    const connector = new BaileysConnector("dot_glue", secrets, { waWebSocketUrl: "ws://127.0.0.1:1/" });
    const connection = await connector.connect(events);
    const deadline = Date.now() + 15_000;
    while (ends.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ends[0]).toMatchObject({ reason: expect.stringMatching(/^(lost|code_expired)$/) });
    expect(codes).toEqual([]);
    await connection.close();
    const writtenBefore = stored.size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stored.size).toBe(writtenBefore);
    // Nothing is sent to a connection that is not up.
    await expect(connection.sendText("393331112222@s.whatsapp.net", "hello")).rejects.toThrow();
  }, 30_000);
});
