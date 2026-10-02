import type { ChatMessage, ToolMessage } from "@invisible-dots/openrouter-client";
import type { DotRuntimeConfig, OutboundEventDataMap, OutboundEventType, ToolDefinition } from "@invisible-dots/shared";

export interface ToolImage {
  mimeType: string;
  base64: string;
}

export interface ToolResult {
  ok: boolean;
  /** What the model reads. Cut to 12000 characters before it is sent. */
  text: string;
  /** Sent to the model as `image_url` parts (screenshots). */
  images?: ToolImage[];
}

/** An outbound event a tool may emit, e.g. `memory.written` or `browser.identity.created`. */
export type ToolEmittedEvent = {
  [K in OutboundEventType]: { type: K; data: OutboundEventDataMap[K] };
}[OutboundEventType];

export interface ToolContext {
  /** Set when the call belongs to a task; absent for chat turns. */
  taskId?: string;
  /** Aborted when the task is cancelled or the agent prepares to sleep. */
  signal: AbortSignal;
  /** Write an outbound event to the outbox. */
  emit(event: ToolEmittedEvent): void;
}

/**
 * What the reasoning loop needs from the tools package. `definitions` returns
 * the tools offered to a Dot with that config (section 8.3); `call` runs one.
 * Policy is not the registry's business: the loop checks it before `call`.
 * `call` should report failures as `{ ok: false, text }`; a throw is turned
 * into the same thing by the loop.
 */
export interface ToolRegistry {
  definitions(config: DotRuntimeConfig): ToolDefinition[];
  call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

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

/**
 * A message as stored in a thread. Tool messages keep their images next to
 * them; the request builder moves the images into a user message, because the
 * OpenAI format allows only text in tool results.
 */
export type StoredToolMessage = ToolMessage & { images?: ToolImage[] };
export type ThreadMessage = Exclude<ChatMessage, ToolMessage> | StoredToolMessage;
