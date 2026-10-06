/**
 * The Baileys glue against the real library. WhatsApp itself cannot be reached from a test, so what is proved here is
 * what the glue decides on its own: how a Baileys message is read (`toIncoming`, over messages built with Baileys' own
 * protobuf classes and passed through its encoder and decoder, so they are the library's objects and not
 * hand-made look-alikes), and that the connector survives a socket that cannot connect. The real network is not
 * tested in CI. Needs the opt-in client installed (`npm run whatsapp:install`): this suite is `npm run test:whatsapp`.
 */
import type { WAMessage } from "baileys";
import { describe, expect, it } from "vitest";
import { BaileysConnector, toIncoming } from "../src/whatsapp-baileys/baileys.js";
import type { WhatsAppEnd, WhatsAppEvents, WhatsAppIncoming } from "../src/whatsapp-baileys/port.js";
import { baileys, CLIENT_DIR, type Baileys } from "./client.js";

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
    const connector = new BaileysConnector("dot_glue", secrets, { clientDir: CLIENT_DIR, waWebSocketUrl: "ws://127.0.0.1:1/" });
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
