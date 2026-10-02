import type { OutboundEventDataMap, OutboundEventType, ToolDefinition } from "@invisible-dots/shared";

/** An image a tool hands to the model, sent as a `data:` URL `image_url` part. */
export interface ToolImage {
  mimeType: string;
  base64: string;
}

/** What one tool call gives back to the reasoning loop. `ok: false` is a result the model reads, not an exception. */
export interface ToolResult {
  ok: boolean;
  text: string;
  images?: ToolImage[];
}

/** An outbound event before the outbox gives it its seq, id and timestamp. */
export type ToolEvent = {
  [K in OutboundEventType]: { type: K; data: OutboundEventDataMap[K] };
}[OutboundEventType];

export interface ToolContext {
  taskId?: string;
  signal: AbortSignal;
  emit(event: ToolEvent): void;
}

/** The part of the Dot configuration that decides which tools are offered. */
export interface ToolOfferConfig {
  browser: { identities: { managed_by_dot: boolean } };
  memory: { enabled: boolean };
}

export interface ToolRegistry {
  definitions(config: ToolOfferConfig): ToolDefinition[];
  call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

type MaybePromise<T> = T | Promise<T>;

export interface MemorySearchHit {
  key: string;
  content: string;
  /** ISO 8601. */
  updated_at?: string;
}

/** Long-term memory as the tools need it; the memory package's DotStore implements it over `dot.db`. */
export interface MemoryToolStore {
  remember(key: string, content: string): MaybePromise<void>;
  search(query: string, limit?: number): MaybePromise<MemorySearchHit[]>;
}
