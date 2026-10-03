// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Tool results as they enter the conversation: one tool message per call,
 * text for the model and the images next to it. The registry already cut the
 * text to its limit; it is not cut a second time here, so a note that follows
 * the result is never lost to a cut.
 */
import type { StoredToolMessage } from "../types.js";
import type { ToolResult } from "./framework.js";

/** The stored tool message for a call's result. A failure reads `Error: ...` to the model. */
export function toolResultMessage(toolCallId: string, result: ToolResult): StoredToolMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: result.ok ? result.text : `Error: ${result.text}`,
    ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
  };
}

/** Characters of a result's text, the size a placeholder reports. */
export function toolResultSize(message: StoredToolMessage): number {
  return message.content.length;
}
