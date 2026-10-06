import { createHash, randomBytes } from "node:crypto";

/** No 0, 1, I, O: a code read off a screen and typed back is not misread. 32 symbols, so 5 bits each. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const PAIRING_CODE_LENGTH = 8;

/** A one-time pairing code: eight symbols, 40 bits, safe in a `t.me/<bot>?start=<code>` link. */
export function newPairingCode(): string {
  let code = "";
  for (const byte of randomBytes(PAIRING_CODE_LENGTH)) code += ALPHABET[byte & 31];
  return code;
}

/** What is typed back may differ in case and have spaces around it. */
export function normalizePairingCode(typed: string): string {
  return typed.trim().toUpperCase();
}

/**
 * What the database keeps of a code. The code is random and short-lived, so a plain SHA-256 is enough
 * to make a leaked database useless; the binding id keeps one code from matching on another binding.
 */
export function hashPairingCode(bindingId: string, code: string): string {
  return createHash("sha256").update(`${bindingId}:${normalizePairingCode(code)}`).digest("hex");
}
