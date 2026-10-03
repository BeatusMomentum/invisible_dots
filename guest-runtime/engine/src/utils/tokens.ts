// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
import type { ThreadMessage } from "../types.js";

/** Fixed cost of an image, in characters, until a model's real figure is known. */
const IMAGE_CHARS = 64;

/**
 * Estimate token count using a lightweight character heuristic.
 * This intentionally avoids model-specific tokenizer dependencies.
 */
export function estimateTokens(messages: readonly ThreadMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") chars += message.content.length;
    else if (Array.isArray(message.content)) {
      for (const part of message.content) chars += part.type === "text" ? part.text.length : IMAGE_CHARS;
    }
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) chars += call.function.name.length + call.function.arguments.length;
    }
    if (message.role === "tool") chars += (message.images?.length ?? 0) * IMAGE_CHARS;
  }
  // Conservative English heuristic: about 4 characters per token.
  return Math.ceil(chars / 4);
}
