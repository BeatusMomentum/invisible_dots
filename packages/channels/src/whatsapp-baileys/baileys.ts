/**
 * The WhatsApp port over Baileys (WhiskeySockets, MIT), an unofficial client of the WhatsApp Web protocol: it
 * links the Dot as a device of a WhatsApp account, which WhatsApp does not allow for automation and can end with
 * the account banned. It is pinned to one exact release candidate because the protocol changes under it.
 *
 * This file is the only one that knows Baileys, and it loads it when a connection opens (`import()`), so a server
 * that never links WhatsApp never loads it. It translates and decides nothing: who may talk, what is answered
 * and how a person is told apart are the channel's (`WhatsAppChannel`). The real network is not reached by any
 * test; what is tested is `toIncoming`, `endOf` and the auth state, which carry the protocol's traps (LID
 * addresses, the many ways a connection closes).
 */
import type { WAMessage, WASocket } from "baileys";
import type { ChannelSecrets } from "../channel.js";
import { AuthStore, type BaileysAuthLib } from "./auth-state.js";
import { isDirectJid, phoneOf } from "./jid.js";
import type { WhatsAppConnection, WhatsAppConnector, WhatsAppContent, WhatsAppEnd, WhatsAppEvents, WhatsAppIncoming } from "./port.js";

type Baileys = typeof import("baileys");

export interface BaileysOptions {
  /** The WebSocket address of WhatsApp; default Baileys'. Tests point it at nothing. */
  waWebSocketUrl?: string;
  /** The WhatsApp Web version to present; default the one Baileys was released with. When WhatsApp stops accepting it, the release has to be upgraded. */
  version?: [number, number, number];
}

/** What shows as the linked device under "Linked devices" on the phone. */
const BROWSER: [string, string, string] = ["invisible_dots", "Desktop", "1.0.0"];

/** Message contents the Dot cannot take: media, contacts and places. */
const ATTACHMENT_KEYS = [
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "ptvMessage",
  "contactMessage",
  "contactsArrayMessage",
  "locationMessage",
  "liveLocationMessage",
] as const;

/** Baileys logs through pino; its lines hold addresses and ids of people, so they are not kept. What matters reaches the channel as `end`. */
const SILENT_LOGGER = {
  level: "silent",
  child() {
    return SILENT_LOGGER;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * The content of a text message. Without `linkPreview: null` Baileys fetches the first link of a text from this
 * machine (the control plane) to attach a preview, so a link in an approval prompt or a Dot's message would be
 * requested, query and all, before anyone approved it. Nothing a Dot names is fetched on its behalf.
 */
export function textContent(text: string): { text: string; linkPreview: null } {
  return { text, linkPreview: null };
}

/** What a Baileys message is to the channel. Null for one that has no id or no chat, which no one could answer. */
export function toIncoming(message: WAMessage, lib: Pick<Baileys, "normalizeMessageContent">): WhatsAppIncoming | null {
  const { id, remoteJid, remoteJidAlt, fromMe } = message.key;
  if (!id || !remoteJid) return null;
  const inner = lib.normalizeMessageContent(message.message);
  const text = inner?.conversation ?? inner?.extendedTextMessage?.text;
  let content: WhatsAppContent = { kind: "none" };
  if (typeof text === "string") content = { kind: "text", text };
  else if (inner && ATTACHMENT_KEYS.some((key) => inner[key])) content = { kind: "attachment" };
  return {
    id,
    chat: remoteJid,
    ...(remoteJidAlt && { chatAlt: remoteJidAlt }),
    fromMe: fromMe === true,
    ...(message.pushName && { senderName: message.pushName }),
    content,
  };
}

/** How Baileys says a connection closed, in the terms of the port. `linked` is whether the device had been linked to an account. */
export function endOf(error: { message?: string; output?: { statusCode?: number } } | undefined, linked: boolean): WhatsAppEnd {
  const code = error?.output?.statusCode;
  switch (code) {
    case 401:
      return { reason: "logged_out" };
    case 403: // forbidden
    case 411: // multi-device mismatch
    case 500: // bad session
      return { reason: "rejected" };
    case 440:
      return { reason: "replaced" };
    case 515:
      return { reason: "restart" };
    case 408:
      // The code was not scanned in time (Baileys gives up after a few codes), or the network dropped while waiting.
      if (!linked) return { reason: "code_expired" };
  }
  return { reason: "lost", detail: `${error?.message ?? "the connection closed"}${code === undefined ? "" : ` (${code})`}` };
}

export class BaileysConnector implements WhatsAppConnector {
  constructor(
    private readonly dotId: string,
    private readonly secrets: ChannelSecrets,
    private readonly options: BaileysOptions = {},
  ) {}

  async connect(events: WhatsAppEvents): Promise<WhatsAppConnection> {
    const lib: Baileys = await import("baileys");
    const auth = await AuthStore.open(this.dotId, this.secrets, lib as unknown as BaileysAuthLib);
    let closing = false;
    const socket = lib.makeWASocket({
      auth: auth.state,
      browser: BROWSER,
      logger: SILENT_LOGGER,
      // Only the chats of single people: a group's members would see what the Dot says, and nothing here answers a group.
      shouldIgnoreJid: (jid) => !isDirectJid(jid),
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      ...(this.options.version && { version: this.options.version }),
      ...(this.options.waWebSocketUrl && { waWebSocketUrl: this.options.waWebSocketUrl }),
    });

    socket.ev.on("creds.update", () => {
      // A failed write is the connection's failure: the keys it used cannot be taken back.
      auth.saveCreds().catch((error: unknown) => events.end({ reason: "lost", detail: `could not save the WhatsApp credentials: ${error instanceof Error ? error.message : String(error)}` }));
    });
    socket.ev.on("connection.update", (update) => {
      if (closing) return;
      if (update.qr) events.code(update.qr);
      if (update.connection === "open") events.open({ phone: phoneOf(socket.user?.id) });
      if (update.connection === "close") events.end(endOf(update.lastDisconnect?.error as Parameters<typeof endOf>[0], auth.linked));
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      // `notify` is a message that arrived; `append` is history and our own sends.
      if (closing || type !== "notify") return;
      for (const message of messages) {
        const incoming = toIncoming(message, lib);
        if (incoming) events.message(incoming);
      }
    });

    return new BaileysConnection(socket, auth, () => {
      closing = true;
    });
  }
}

export class BaileysConnection implements WhatsAppConnection {
  constructor(
    private readonly socket: WASocket,
    private readonly auth: AuthStore,
    private readonly beginClosing: () => void,
  ) {}

  async sendText(chat: string, text: string): Promise<string> {
    const sent = await this.socket.sendMessage(chat, textContent(text));
    if (!sent?.key.id) throw new Error("WhatsApp did not say it took the message");
    return sent.key.id;
  }

  async editText(chat: string, id: string, text: string): Promise<void> {
    await this.socket.sendMessage(chat, { ...textContent(text), edit: { remoteJid: chat, id, fromMe: true } });
  }

  async markRead(message: { chat: string; id: string }): Promise<void> {
    await this.socket.readMessages([{ remoteJid: message.chat, id: message.id, fromMe: false }]);
  }

  async typing(chat: string): Promise<void> {
    await this.socket.sendPresenceUpdate("composing", chat);
  }

  async phoneForLid(lid: string): Promise<string | null> {
    return phoneOf(await this.socket.signalRepository.lidMapping.getPNForLID(`${lid}@lid`));
  }

  async close(): Promise<void> {
    this.beginClosing();
    await this.socket.end(undefined);
    await this.auth.close();
  }
}
