/**
 * Compile-time proof that the real Baileys module has the shape the adapter wrote down in `client.ts`: the typecheck
 * of `tsconfig.whatsapp.json` (`npm run typecheck:whatsapp`, after `npm run whatsapp:install`) fails on any line here
 * that stops being true, for example when an upgrade of the pinned release renames something the adapter uses. It is
 * not a test run and nothing imports it.
 */
import type * as Baileys from "baileys";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "baileys";
import { AuthStore, GROUP_SECRETS } from "../src/whatsapp-baileys/auth-state.js";
import { socketConfig } from "../src/whatsapp-baileys/baileys.js";
import type { SignalKeyGroup, WhatsAppClient, WhatsAppSocketConfig } from "../src/whatsapp-baileys/client.js";

/** One direction of assignability, strictly: `true` when a `From` can be used where a `To` is wanted. */
type Fits<From, To> = [From] extends [To] ? true : false;

/**
 * The module is a `WhatsAppClient`, with the library's own credentials and key data in place of the adapter's loose view.
 * Its methods are compared both ways (they are methods), so what the adapter passes in is proved below, one way.
 */
export const moduleFits: WhatsAppClient<AuthenticationCreds, SignalDataTypeMap> = {} as typeof Baileys;

/** The socket it makes is a `WhatsAppSocket`. */
export const socketFits: ReturnType<WhatsAppClient["makeWASocket"]> = {} as ReturnType<typeof Baileys.makeWASocket>;

/** The options the adapter passes to `makeWASocket` are, for each one, an option of the library with a type the library takes... */
type LibraryOptions = Parameters<typeof Baileys.makeWASocket>[0];
export const optionsFit: Fits<ReturnType<typeof socketConfig<AuthenticationState>>, LibraryOptions> = true;
/** ...and none is a name the library does not have (a renamed option would otherwise be passed and ignored without a word). */
export const noUnknownOption: Exclude<keyof WhatsAppSocketConfig, keyof LibraryOptions> extends never ? true : false = true;

/** The auth state the adapter builds is one the library takes: its credentials are the ones `initAuthCreds` makes, and its key store answers as the library's does. */
export const authFits: Fits<AuthStore<AuthenticationCreds, SignalDataTypeMap>["state"], AuthenticationState> = true;

/** The groups of keys are exactly the library's: neither a missing nor an extra one. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const sameGroups: Same<SignalKeyGroup, keyof SignalDataTypeMap> = true;
export const everyGroupHasASecret: Record<keyof SignalDataTypeMap, string> = GROUP_SECRETS;
