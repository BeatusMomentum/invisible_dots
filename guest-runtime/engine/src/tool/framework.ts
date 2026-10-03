// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Tool framework: what the engine needs from a tool registry.
 *
 * The tools themselves, their JSON Schemas and their argument validation live
 * in `@invisible-dots/tools` and in the tool table of `@invisible-dots/shared`
 * (architecture section 8.3); this module is only the contract between them
 * and the engine, so there is one definition of every tool.
 */
import type { DotRuntimeConfig, OutboundEventDataMap, OutboundEventType, ToolDefinition } from "@invisible-dots/shared";
import type { ToolImage } from "../types.js";

export type { ToolDefinition };

/** What one tool call gives back. `ok: false` is a result the model reads, not an exception. */
export interface ToolResult {
  ok: boolean;
  /** What the model reads. */
  text: string;
  /** Sent to the model as `image_url` parts (screenshots). */
  images?: ToolImage[];
}

/** An outbound event a tool may emit, e.g. `memory.written` or `browser.identity.created`. */
export type ToolEmittedEvent = {
  [K in OutboundEventType]: { type: K; data: OutboundEventDataMap[K] };
}[OutboundEventType];

/** Context injected into every tool execution. */
export interface ToolContext {
  /** Set when the call belongs to a task; absent for chat turns. */
  taskId?: string;
  /** Aborted when the task is cancelled or the agent prepares to sleep. */
  signal: AbortSignal;
  /** Write an outbound event to the outbox. */
  emit(event: ToolEmittedEvent): void;
}

/**
 * The registry the engine runs tools through. `definitions` returns the tools
 * offered to a Dot with that config (section 8.3); `call` validates the
 * arguments against the tool's schema and runs it. `call` reports failures as
 * `{ ok: false, text }`; a throw is turned into the same thing by the executor.
 */
export interface ToolRegistry {
  definitions(config: DotRuntimeConfig): ToolDefinition[];
  call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
