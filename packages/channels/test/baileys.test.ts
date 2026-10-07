/**
 * What the Baileys glue decides on its own, without the library: how a closed connection is understood (`endOf`) and
 * how WhatsApp addresses are told apart. The parts that need the real library (how a message is read, the connector
 * on a socket that cannot connect, that Baileys fetches no link of a text) are in packages/channels/test-optin, run by
 * `npm run test:whatsapp`.
 */
import { describe, expect, it } from "vitest";
import { BaileysConnection, endOf } from "../src/whatsapp-baileys/baileys.js";
import { isDirectJid, lidOf, phoneOf } from "../src/whatsapp-baileys/jid.js";

describe("what is sent", () => {
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
