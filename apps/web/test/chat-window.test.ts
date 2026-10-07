import { describe, expect, it } from "vitest";
import { CHAT_PAGE_SIZE, withEarlierPage, withNewestPage } from "../src/lib/chat-window";
import type { ChatMessage } from "../src/lib/types";

const message = (id: number): ChatMessage => ({ event_id: id, role: id % 2 === 0 ? "assistant" : "user", text: `m${id}`, in_reply_to: null, created_at: "2026-03-10T12:00:00Z" });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => message(from + i));
const ids = (messages: readonly ChatMessage[]) => messages.map((m) => m.event_id);

describe("the newest page of the conversation", () => {
  it("is the whole conversation when it is shorter than a page", () => {
    const window = withNewestPage(undefined, range(1, 5));
    expect(ids(window.messages)).toEqual([1, 2, 3, 4, 5]);
    expect(window.earlier).toBe(false);
  });

  it("is a window with earlier messages behind it when the page is full", () => {
    const window = withNewestPage(undefined, range(11, 10 + CHAT_PAGE_SIZE));
    expect(window.messages).toHaveLength(CHAT_PAGE_SIZE);
    expect(window.earlier).toBe(true);
  });

  it("joins what is held when it reaches back to it, and keeps the earlier messages that were read", () => {
    const held = withEarlierPage(withNewestPage(undefined, range(201, 200 + CHAT_PAGE_SIZE)), range(101, 200));
    const after = withNewestPage(held, range(210, 209 + CHAT_PAGE_SIZE));
    expect(ids(after.messages)).toEqual(ids(range(101, 209 + CHAT_PAGE_SIZE)));
    expect(after.earlier).toBe(true);
  });

  it("replaces what is held when more than a page came in since, so that no message is missing in the middle", () => {
    const held = withNewestPage(undefined, range(1, CHAT_PAGE_SIZE));
    const after = withNewestPage(held, range(10 * CHAT_PAGE_SIZE + 1, 11 * CHAT_PAGE_SIZE));
    expect(ids(after.messages)).toEqual(ids(range(10 * CHAT_PAGE_SIZE + 1, 11 * CHAT_PAGE_SIZE)));
    expect(after.earlier).toBe(true);
  });

  it("takes in one message that arrived, and not twice one it already has", () => {
    const held = withNewestPage(undefined, range(1, 5));
    expect(ids(withNewestPage(held, range(1, 6)).messages)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("an earlier page", () => {
  it("goes in front of what is held, and says whether more is behind it", () => {
    const held = withNewestPage(undefined, range(CHAT_PAGE_SIZE + 1, 2 * CHAT_PAGE_SIZE));
    const more = withEarlierPage(held, range(1, CHAT_PAGE_SIZE));
    expect(ids(more.messages)).toEqual(ids(range(1, 2 * CHAT_PAGE_SIZE)));
    expect(more.earlier).toBe(true);
    const last = withEarlierPage(more, range(1, 3));
    expect(last.earlier).toBe(false);
  });
});
