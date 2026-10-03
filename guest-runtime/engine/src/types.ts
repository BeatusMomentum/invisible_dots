// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Core types of the engine.
 *
 * The conversation is kept in the OpenAI chat shape the model client speaks
 * and `dot.db` stores, so there is one message model from the database to
 * the wire: no content blocks, no conversion in either direction.
 */
import type { ChatMessage, ToolMessage } from "@invisible-dots/openrouter-client";

/** An image a tool hands to the model, sent as a `data:` URL `image_url` part. */
export interface ToolImage {
  mimeType: string;
  base64: string;
}

/**
 * A message as stored in a thread. Tool messages keep their images next to
 * them; the request builder moves the images into a user message, because the
 * OpenAI format allows only text in tool results.
 */
export type StoredToolMessage = ToolMessage & { images?: ToolImage[] };
export type ThreadMessage = Exclude<ChatMessage, ToolMessage> | StoredToolMessage;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Configuration for agent loop detection. */
export interface LoopDetectionConfig {
  /**
   * Maximum consecutive times the same tool call (name + args) or text
   * output can repeat before detection triggers. Default: `3`.
   */
  readonly maxRepetitions?: number;
  /** Number of recent turns to track for repetition analysis. Default: `4`. */
  readonly loopDetectionWindow?: number;
}

/** Diagnostic payload when a loop is detected. */
export interface LoopDetectionInfo {
  readonly kind: "tool_repetition" | "text_repetition";
  /** Number of consecutive identical occurrences observed. */
  readonly repetitions: number;
  /** Human-readable description of the detected loop. */
  readonly detail: string;
}
