/**
 * The WhatsApp client (Baileys, MIT) is not part of the default install: it depends on `libsignal`, which is GPL-3.0,
 * and nothing under a GPL license is installed unless the person asks for it. It lives apart from the workspaces, in
 * `optional/whatsapp/` (its own `package.json` and lock file, every package with its integrity hash), and one
 * command installs it: `npm run whatsapp:install` from the repository root.
 *
 * This file is the only one that names the library. It looks for it in that folder when a connection opens, loads it
 * only if it is there, and otherwise fails with the words that say how to enable it. What the adapter uses of the
 * library is written down here as `WhatsAppClient`: the adapter is compiled without the library installed, and a
 * typecheck made with it installed (`npm run typecheck:whatsapp`, a job of CI) proves the real module has this shape,
 * that the socket options the adapter passes are options the library has, with the types it gives them, and that the
 * adapter's auth state is one the library accepts. The library's types come in as type parameters (`Creds`, `KeyData`),
 * which that typecheck fills with the library's own; the adapter uses the defaults.
 *
 * The one version of the library is the one `optional/whatsapp/package.json` declares, exactly. What is installed is
 * compared with it every time the client is looked for, because a pull that moves the pin leaves the old release in
 * `node_modules` until the person installs again.
 */
import { existsSync, readFileSync } from "node:fs";
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

/** A client is installed, but not the release this checkout pins: it was installed before the pin moved, or by hand. The message names the fix, the same command. */
export class WhatsAppClientVersionError extends Error {
  constructor(
    readonly pinned: string | null,
    readonly installed: string | null,
  ) {
    super(`The installed WhatsApp client is ${installed ?? "of an unknown version"}, and this checkout pins baileys ${pinned ?? "at no version"} (optional/whatsapp/package.json): ${WHATSAPP_ENABLE_HELP}.`);
    this.name = "WhatsAppClientVersionError";
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

/** What the library keeps under each group of keys. The adapter does not look inside; the typecheck with the library installed sets it to the library's own map. */
export type SignalKeyData = Record<SignalKeyGroup, unknown>;

/** What `makeWASocket` takes as `auth`. */
export interface WhatsAppAuthState<Creds extends WhatsAppCreds = WhatsAppCreds, KeyData extends SignalKeyData = SignalKeyData> {
  creds: Creds;
  keys: {
    get<G extends SignalKeyGroup>(type: G, ids: string[]): Promise<Record<string, KeyData[G]>>;
    set(data: { [G in SignalKeyGroup]?: Record<string, KeyData[G] | null> }): Promise<void>;
  };
}

/** What the adapter passes to `makeWASocket`: exactly these options, no other, so the typecheck with the library installed can prove each one is the library's. Built by `socketConfig` (baileys.ts). */
export interface WhatsAppSocketConfig<Auth = WhatsAppAuthState> {
  auth: Auth;
  /** What shows as the linked device under "Linked devices" on the phone. */
  browser: [string, string, string];
  logger: WhatsAppLogger;
  shouldIgnoreJid: (jid: string) => boolean;
  shouldSyncHistoryMessage: () => boolean;
  syncFullHistory: boolean;
  markOnlineOnConnect: boolean;
  generateHighQualityLinkPreview: boolean;
  /** The WhatsApp Web version to present; absent is the one the library was released with. */
  version?: [number, number, number];
  /** The WebSocket address of WhatsApp; absent is the library's. */
  waWebSocketUrl?: string;
}

/** The logger the library calls (pino's shape). */
export interface WhatsAppLogger {
  level: string;
  child(bindings: Record<string, unknown>): WhatsAppLogger;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
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
  sendMessage(jid: string, content: { text: string; linkPreview?: null; edit?: { remoteJid: string; id: string; fromMe: boolean } }): Promise<{ key: { id?: string | null } } | undefined>;
  readMessages(keys: { remoteJid: string; id: string; fromMe: boolean }[]): Promise<void>;
  sendPresenceUpdate(type: "composing", jid: string): Promise<void>;
  end(error: Error | undefined): void | Promise<void>;
}

/**
 * What the adapter uses of the Baileys module. Methods, not properties, so their parameters are compared loosely
 * (in both directions) by the typecheck of `shape.ts`: what the adapter passes in is therefore checked there on its
 * own, in one direction, for the socket options (`WhatsAppSocketConfig`) and the auth state (`WhatsAppAuthState`).
 */
export interface WhatsAppClient<Creds extends WhatsAppCreds = WhatsAppCreds, KeyData extends SignalKeyData = SignalKeyData> {
  makeWASocket(config: WhatsAppSocketConfig<WhatsAppAuthState<Creds, KeyData>>): WhatsAppSocket;
  normalizeMessageContent(content: WhatsAppMessageContent | null | undefined): WhatsAppMessageContent | undefined;
  initAuthCreds(): Creds;
  BufferJSON: { replacer(key: string, value: unknown): unknown; reviver(key: string, value: unknown): unknown };
  proto: { Message: { AppStateSyncKeyData: { fromObject(object: { [key: string]: unknown }): KeyData["app-state-sync-key"] } } };
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

/** A string field of a JSON file, null when the file or the field is not there. */
function readString(file: string, ...path: string[]): string | null {
  try {
    let value: unknown = JSON.parse(readFileSync(file, "utf8"));
    for (const key of path) value = (value as Record<string, unknown> | null)?.[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** The entry point of a client that is installed and is the pinned release, else the reason it cannot be used. */
function inspect(dir: string): { entry: string } | { problem: WhatsAppClientMissingError | WhatsAppClientVersionError } {
  const entry = entryOf(dir);
  if (entry === null) return { problem: new WhatsAppClientMissingError() };
  // The pin is what `optional/whatsapp/package.json` declares, one exact version; the installed release must be that one.
  const pinned = readString(join(dir, "package.json"), "dependencies", "baileys");
  const installed = readString(join(dir, "node_modules", "baileys", "package.json"), "version");
  if (pinned === null || pinned !== installed) return { problem: new WhatsAppClientVersionError(pinned, installed) };
  return { entry };
}

/** Why the client under `dir` cannot be loaded, or null when it can: the check `loadWhatsAppClient` makes, for whoever says so before a connection opens. */
export function whatsappClientProblem(dir: string): WhatsAppClientMissingError | WhatsAppClientVersionError | null {
  const found = inspect(dir);
  return "problem" in found ? found.problem : null;
}

/** Load the client from `dir`; throws `WhatsAppClientMissingError` when it is not installed there and `WhatsAppClientVersionError` when it is not the pinned release. */
export async function loadWhatsAppClient(dir: string): Promise<WhatsAppClient> {
  const found = inspect(dir);
  if ("problem" in found) throw found.problem;
  return (await import(pathToFileURL(found.entry).href)) as WhatsAppClient;
}
