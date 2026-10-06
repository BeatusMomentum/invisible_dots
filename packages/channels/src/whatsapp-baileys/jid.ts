/**
 * WhatsApp addresses (JIDs). A person has two: a phone address `<number>@s.whatsapp.net` and, since WhatsApp
 * began hiding numbers, a LID address `<id>@lid`; the same chat can arrive under either. A device suffix
 * (`:5`) and an agent suffix (`_1`) belong to the connection, not to the person.
 */

const PHONE_SERVER = "s.whatsapp.net";
const LID_SERVER = "lid";

function split(jid: string): { user: string; server: string } | null {
  const at = jid.lastIndexOf("@");
  if (at < 1) return null;
  const user = jid.slice(0, at).split(":")[0]!.split("_")[0]!;
  return user === "" ? null : { user, server: jid.slice(at + 1) };
}

/** The number of a phone address, digits only; null for any other address. */
export function phoneOf(jid: string | null | undefined): string | null {
  const parts = jid ? split(jid) : null;
  return parts?.server === PHONE_SERVER && /^\d{5,20}$/.test(parts.user) ? parts.user : null;
}

/** The id of a LID address; null for any other address. */
export function lidOf(jid: string | null | undefined): string | null {
  const parts = jid ? split(jid) : null;
  return parts?.server === LID_SERVER && /^\d{5,30}$/.test(parts.user) ? parts.user : null;
}

/** A chat with one person, as opposed to a group, a broadcast list, a channel or a business account. */
export function isDirectJid(jid: string | null | undefined): boolean {
  return phoneOf(jid) !== null || lidOf(jid) !== null;
}

export const phoneJid = (phone: string): string => `${phone}@${PHONE_SERVER}`;
export const lidJid = (lid: string): string => `${lid}@${LID_SERVER}`;
