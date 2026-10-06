/**
 * Compile-time proof that the real Baileys module has the shape the adapter wrote down in `client.ts`: the typecheck
 * of `tsconfig.whatsapp.json` (`npm run typecheck:whatsapp`, after `npm run whatsapp:install`) fails on any line here
 * that stops being true, for example when an upgrade of the pinned release renames something the adapter uses. It is
 * not a test run and nothing imports it.
 */
import type * as Baileys from "baileys";
import type { SignalDataTypeMap } from "baileys";
import { GROUP_SECRETS } from "../src/whatsapp-baileys/auth-state.js";
import type { SignalKeyGroup, WhatsAppClient } from "../src/whatsapp-baileys/client.js";

/** The module is a `WhatsAppClient`. */
export const moduleFits: WhatsAppClient = {} as typeof Baileys;

/** The socket it makes is a `WhatsAppSocket`. */
export const socketFits: ReturnType<WhatsAppClient["makeWASocket"]> = {} as ReturnType<typeof Baileys.makeWASocket>;

/** The groups of keys are exactly the library's: neither a missing nor an extra one. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const sameGroups: Same<SignalKeyGroup, keyof SignalDataTypeMap> = true;
export const everyGroupHasASecret: Record<keyof SignalDataTypeMap, string> = GROUP_SECRETS;
