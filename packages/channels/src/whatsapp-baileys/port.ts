/**
 * What the WhatsApp channel needs of a connection to WhatsApp, and nothing of how it is made. The Baileys glue
 * implements it over the real network; `FakeWhatsAppConnector` implements it for tests, because WhatsApp
 * itself cannot be faked. Everything WhatsApp-specific that is a decision (who is who, what is answered)
 * lives in the channel above this port and is tested against the fake.
 */

/** One message as the connection saw it, before any decision. */
export interface WhatsAppIncoming {
  /** WhatsApp's id for the message. */
  id: string;
  /** The chat's address as WhatsApp gave it: `<number>@s.whatsapp.net`, `<id>@lid`, or a group's, a list's. */
  chat: string;
  /** The same chat under the other kind of address, when WhatsApp said so. */
  chatAlt?: string;
  /** Written by the linked account itself, from its phone or another device. */
  fromMe: boolean;
  /** The name the sender gave their own profile; a label, never an identity. */
  senderName?: string;
  content: WhatsAppContent;
}

export type WhatsAppContent =
  | { kind: "text"; text: string }
  /** A photo, a voice note, a document, a location: something the Dot cannot take. */
  | { kind: "attachment" }
  /** A reaction, a receipt, a protocol message: nothing for anyone. */
  | { kind: "none" };

/** Why a connection ended. */
export type WhatsAppEnd =
  /** The device was removed on the phone ("Linked devices"). */
  | { reason: "logged_out" }
  /** WhatsApp does not accept this linked device any more (restricted or banned account, a broken session). */
  | { reason: "rejected" }
  /** Another session of the same linked device took over. */
  | { reason: "replaced" }
  /** WhatsApp asks for a new connection; it is how a link ends, and not a failure. */
  | { reason: "restart" }
  /** The device was never linked and the connection ended before the code was scanned. */
  | { reason: "code_expired" }
  | { reason: "lost"; detail: string };

/** What a connection tells the channel. None of these throws. */
export interface WhatsAppEvents {
  /** The code the phone scans to link; a new one replaces the last. */
  code(code: string): void;
  /** Linked and connected; `phone` is the number of the linked account. */
  open(account: { phone: string | null }): void;
  message(message: WhatsAppIncoming): void;
  end(end: WhatsAppEnd): void;
}

/** What the channel asks of a live connection. Failures are plain errors: the hub retries them. */
export interface WhatsAppConnection {
  /** Send text to a chat; resolves with the id of the sent message. */
  sendText(chat: string, text: string): Promise<string>;
  /** Replace the text of a message this account sent. */
  editText(chat: string, id: string, text: string): Promise<void>;
  /** Tell the sender that the message was read. */
  markRead(message: { chat: string; id: string }): Promise<void>;
  /** Show "typing..." in a chat. */
  typing(chat: string): Promise<void>;
  /** The number behind a LID, from what this account has learned so far; null when unknown. No query goes to WhatsApp. */
  phoneForLid(lid: string): Promise<string | null>;
  /** Hang up and settle everything that was being written. The connection takes no further call. */
  close(): Promise<void>;
}

export interface WhatsAppConnector {
  /** Open a connection; its events arrive on `events` until it ends. Rejects when it cannot even start. */
  connect(events: WhatsAppEvents): Promise<WhatsAppConnection>;
}
