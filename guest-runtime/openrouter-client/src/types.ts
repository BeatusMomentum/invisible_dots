/**
 * The subset of the OpenAI chat.completions format that OpenRouter accepts and
 * this project uses: text and image parts, function tools, no streaming.
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** A function tool in the OpenAI format. */
export interface FunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: FunctionTool[];
  temperature?: number;
  max_tokens?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** USD, when OpenRouter reports it. */
  cost?: number;
}

/** A tool call whose arguments were decoded, or the reason they could not be. */
export interface ParsedToolCall {
  id: string;
  name: string;
  /** The raw JSON string the model produced. */
  rawArguments: string;
  /** Decoded arguments; an empty object when the model sent an empty string. */
  arguments: Record<string, unknown> | null;
  /** Set when `rawArguments` is not a JSON object. */
  argumentsError?: string;
}

export interface ChatResult {
  /** The assistant message exactly as it should be appended to the history. */
  message: AssistantMessage;
  /** Text of the answer, empty when the model only called tools. */
  text: string;
  toolCalls: ParsedToolCall[];
  finishReason: string | null;
  usage: Usage;
  /** The model that actually answered, as OpenRouter reports it. */
  model: string;
  generationId: string | null;
  /** Attempts it took, 1 when the first request succeeded. */
  attempts: number;
}

export interface ChatOptions {
  signal?: AbortSignal;
}

/**
 * What the agent runtime needs from a model client. OpenRouterClient
 * implements it; tests implement it with fakes.
 */
export interface ChatModel {
  readonly configured: boolean;
  chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResult>;
}
