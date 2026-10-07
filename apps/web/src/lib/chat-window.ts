/**
 * The part of the conversation the chat holds: the newest messages, and the older ones the person asked for. The
 * conversation of a persistent Dot grows for as long as it lives, so the chat reads the newest page of it
 * (`GET /api/dots/:id/messages?order=desc`) and goes back one page at a time, with `before`.
 */
import type { ChatMessage } from "./types";

/** How many messages one request of the chat asks for. */
export const CHAT_PAGE_SIZE = 100;

export interface ChatWindow {
  /** The messages held, oldest first. */
  messages: ChatMessage[];
  /** There may be messages older than the oldest held. */
  earlier: boolean;
}

function union(a: readonly ChatMessage[], b: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<number, ChatMessage>();
  for (const message of a) byId.set(message.event_id, message);
  for (const message of b) byId.set(message.event_id, message);
  return [...byId.values()].sort((x, y) => x.event_id - y.event_id);
}

/**
 * The window after the newest page of the conversation was read (oldest first). A page that reaches back to what is
 * held joins it; a full page that does not (more than a page came in since) replaces it, so that no message is
 * missing between the older ones and the newer, and the older ones are one "earlier" away again.
 */
export function withNewestPage(held: ChatWindow | undefined, page: readonly ChatMessage[]): ChatWindow {
  const full = page.length >= CHAT_PAGE_SIZE;
  if (!full) return { messages: union(held?.messages ?? [], page), earlier: false };
  const newestHeld = held?.messages.at(-1)?.event_id;
  const reaches = newestHeld !== undefined && newestHeld >= page[0]!.event_id;
  return reaches ? { messages: union(held!.messages, page), earlier: held!.earlier } : { messages: [...page], earlier: true };
}

/** The window after the page just before its oldest message was read (oldest first). */
export function withEarlierPage(held: ChatWindow, page: readonly ChatMessage[]): ChatWindow {
  return { messages: union(held.messages, page), earlier: page.length >= CHAT_PAGE_SIZE };
}
