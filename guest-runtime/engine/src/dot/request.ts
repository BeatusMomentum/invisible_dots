/**
 * The request a step sends (architecture section 8.6): what of a thread the
 * model sees on each turn, and which calls of a thread still wait for a result.
 */
import { imagePart, type ChatMessage, type ContentPart, type ToolCall } from "@invisible-dots/openrouter-client";
import { WORKING_MEMORY_MESSAGES } from "@invisible-dots/shared";
import type { StoredMessage } from "@invisible-dots/memory";
import type { ThreadMessage, ToolImage } from "../types.js";

/** Messages of a thread read for one step. */
export const THREAD_READ_LIMIT = 200;

/** The result of a call its unit never ran. */
export const NOT_EXECUTED_TEXT = "Not executed: the unit ended before this call ran.";

/** Only the newest images are re-sent; older screenshots cost tokens and say little. */
export const IMAGES_KEPT = 3;

/**
 * Keep the last `max` messages. A cut must not separate tool results from the
 * assistant message that asked for them, because providers refuse a tool
 * result with no matching call, so leading tool messages are dropped too.
 */
export function trimThread(messages: readonly ThreadMessage[], max: number = WORKING_MEMORY_MESSAGES): ThreadMessage[] {
  let start = Math.max(messages.length - max, 0);
  while (start < messages.length && messages[start]!.role === "tool") start++;
  return messages.slice(start);
}

/**
 * Turn stored thread messages into request messages: images carried by tool
 * results become one user message right after the run of tool results, and
 * only the newest `imagesKept` images are sent at all.
 */
export function toRequestMessages(messages: readonly ThreadMessage[], imagesKept: number = IMAGES_KEPT): ChatMessage[] {
  const imageBudget = new Map<ThreadMessage, number>();
  let remaining = imagesKept;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool" || !m.images || m.images.length === 0) continue;
    const kept = Math.min(remaining, m.images.length);
    imageBudget.set(m, kept);
    remaining -= kept;
  }

  const out: ChatMessage[] = [];
  let pending: ToolImage[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const parts: ContentPart[] = [{ type: "text", text: "Images returned by the tool calls above:" }];
    for (const image of pending) parts.push(imagePart(image.mimeType, image.base64));
    out.push({ role: "user", content: parts });
    pending = [];
  };

  for (const m of messages) {
    if (m.role !== "tool") {
      flush();
      out.push(m);
      continue;
    }
    const images = m.images ?? [];
    const kept = imageBudget.get(m) ?? 0;
    const dropped = images.length - kept;
    pending.push(...images.slice(images.length - kept));
    const note = dropped > 0 ? `\n[${dropped} older image(s) from this call are no longer shown]` : "";
    out.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content + note });
  }
  flush();
  return out;
}

/** A call of an assistant message that has no result yet, with its position in that message. */
export interface OpenCall {
  call: ToolCall;
  index: number;
}

/**
 * The open calls of a thread: the calls of the newest assistant message that
 * have no result yet, in the model's order, with that message's id. Null
 * when the newest assistant message was answered.
 */
export function openCalls(messages: readonly StoredMessage<ThreadMessage>[]): { messageId: number; calls: OpenCall[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!.message;
    if (m.role === "assistant") {
      const answered = new Set(
        messages
          .slice(i + 1)
          .map((x) => x.message)
          .filter((x): x is Extract<ThreadMessage, { role: "tool" }> => x.role === "tool")
          .map((x) => x.tool_call_id),
      );
      const calls = (m.tool_calls ?? []).map((call, index) => ({ call, index })).filter((c) => !answered.has(c.call.id));
      return calls.length === 0 ? null : { messageId: messages[i]!.id, calls };
    }
    if (m.role !== "tool") return null;
  }
  return null;
}

/**
 * Every call in a request is followed by its result. The units that end
 * answer the calls they leave open, so a break here is a fault in the engine:
 * the unit fails with this error rather than repairing the thread a second
 * time in another place, and rather than sending a request the provider
 * would refuse on every later turn.
 */
export function assertCallsAnswered(messages: readonly ThreadMessage[]): void {
  const answered = new Set<string>();
  for (const m of messages) if (m.role === "tool") answered.add(m.tool_call_id);
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.tool_calls ?? []) {
      if (!answered.has(call.id)) throw new Error(`the thread holds the call ${call.id} (${call.function.name}) without its result`);
    }
  }
}
