/**
 * The WhatsApp client (Baileys, MIT) is not part of the default install: it depends on `libsignal`, which is GPL-3.0,
 * and nothing under a GPL license is installed unless the person asks for it. It lives apart from the workspaces, in
 * `optional/whatsapp/` (its own `package.json` and lock file, every package with its integrity hash), and one
 * command installs it: `npm run whatsapp:install` from the repository root.
 *
 * This file is the only one that names the library. It looks for it in that folder when a connection opens, loads it
 * only if it is there, and otherwise fails with the words that say how to enable it. What the adapter uses of the
 * library is written down here as `WhatsAppClient`: the adapter is compiled without the library installed, and a
 * typecheck made with it installed (`npm run typecheck:whatsapp`, a job of CI) proves the real module has this shape.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV } from "@invisible-dots/shared";

/** The one command that installs the client. A script of the root `package.json`. */
export const WHATSAPP_INSTALL_COMMAND = "npm run whatsapp:install";

/** Where the client is installed, under the repository root. */
export function whatsappClientDir(repoRoot: string): string {
  return join(repoRoot, "optional", "whatsapp");
}

/** The words that say how to enable WhatsApp; the one place they are written. */
export const WHATSAPP_ENABLE_HELP = `run \`${WHATSAPP_INSTALL_COMMAND}\` in the invisible_dots folder to install the client, then start the server with ${ENV.WHATSAPP}=1`;

/** The client is not installed. The message names the fix; retrying finds it as soon as the person has done it. */
export class WhatsAppClientMissingError extends Error {
  constructor() {
    super(`The WhatsApp client is not installed. It is optional because it depends on libsignal, which is GPL-3.0: ${WHATSAPP_ENABLE_HELP}.`);
    this.name = "WhatsAppClientMissingError";
  }
}

/** The signalling keys a linked device keeps, one secret each. */
export type SignalKeyGroup =
  | "pre-key"
  | "session"
  | "sender-key"
  | "sender-key-memory"
  | "app-state-sync-key"
  | "app-state-sync-version"
  | "lid-mapping"
  | "device-list"
  | "tctoken"
  | "identity-key";

/** The credentials of a linked device. The adapter reads one field (`me`, set once an account is linked) and stores the rest as the library made it. */
export interface WhatsAppCreds {
  me?: unknown;
}

/** What `makeWASocket` takes as `auth`. */
export interface WhatsAppAuthState {
  creds: WhatsAppCreds;
  keys: {
    get(type: SignalKeyGroup, ids: string[]): Promise<Record<string, unknown>>;
    set(data: Partial<Record<SignalKeyGroup, Record<string, unknown>>>): Promise<void>;
  };
}

/** A message as the library hands it over. */
export interface WhatsAppMessage {
  key: { id?: string | null; remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null };
  message?: WhatsAppMessageContent | null;
  pushName?: string | null;
}

/** The parts of a message's content the adapter reads: text, and which kinds of attachment there are. */
export interface WhatsAppMessageContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: unknown;
  videoMessage?: unknown;
  audioMessage?: unknown;
  documentMessage?: unknown;
  stickerMessage?: unknown;
  ptvMessage?: unknown;
  contactMessage?: unknown;
  contactsArrayMessage?: unknown;
  locationMessage?: unknown;
  liveLocationMessage?: unknown;
}

export interface WhatsAppConnectionUpdate {
  qr?: string;
  connection?: "connecting" | "open" | "close";
  lastDisconnect?: { error?: unknown };
}

export interface WhatsAppSocket {
  ev: {
    on(event: "creds.update", listener: () => void): void;
    on(event: "connection.update", listener: (update: WhatsAppConnectionUpdate) => void): void;
    on(event: "messages.upsert", listener: (upsert: { messages: WhatsAppMessage[]; type: string }) => void): void;
  };
  user?: { id?: string } | undefined;
  signalRepository: { lidMapping: { getPNForLID(lid: string): Promise<string | null | undefined> } };
  sendMessage(jid: string, content: { text: string; edit?: { remoteJid: string; id: string; fromMe: boolean } }): Promise<{ key: { id?: string | null } } | undefined>;
  readMessages(keys: { remoteJid: string; id: string; fromMe: boolean }[]): Promise<void>;
  sendPresenceUpdate(type: "composing", jid: string): Promise<void>;
  end(error: Error | undefined): void | Promise<void>;
}

/** What the adapter uses of the Baileys module. Methods, not properties: their parameters are checked loosely, because the library's own are narrower than the adapter needs to promise. */
export interface WhatsAppClient {
  makeWASocket(config: object): WhatsAppSocket;
  normalizeMessageContent(content: WhatsAppMessageContent | null | undefined): WhatsAppMessageContent | undefined;
  initAuthCreds(): WhatsAppCreds;
  BufferJSON: { replacer(key: string, value: unknown): unknown; reviver(key: string, value: unknown): unknown };
  proto: { Message: { AppStateSyncKeyData: { fromObject(object: { [key: string]: unknown }): unknown } } };
}

/** The path of the library's entry point under `dir`, or null when it is not installed there. */
function entryOf(dir: string): string | null {
  if (!existsSync(join(dir, "node_modules", "baileys"))) return null;
  try {
    return createRequire(join(dir, "package.json")).resolve("baileys");
  } catch {
    return null;
  }
}

/** Whether the client is installed under `dir`. */
export function whatsappClientInstalled(dir: string): boolean {
  return entryOf(dir) !== null;
}

/** Load the client from `dir`; throws `WhatsAppClientMissingError` when it is not installed there. */
export async function loadWhatsAppClient(dir: string): Promise<WhatsAppClient> {
  const entry = entryOf(dir);
  if (entry === null) throw new WhatsAppClientMissingError();
  return (await import(pathToFileURL(entry).href)) as WhatsAppClient;
}
