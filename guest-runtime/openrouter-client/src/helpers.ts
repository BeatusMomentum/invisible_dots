import type { ToolDefinition } from "@invisible-dots/shared";
import type { FunctionTool, ImagePart, Usage } from "./types.js";

/** Tool definitions in the OpenAI function format. */
export function toFunctionTools(definitions: readonly ToolDefinition[]): FunctionTool[] {
  return definitions.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

/** An `image_url` part carrying base64 image bytes as a data URL (section 8.5). */
export function imagePart(mimeType: string, base64: string): ImagePart {
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } };
}

/** Usage summed over several requests, e.g. every model turn of one task. */
export class UsageAccumulator {
  promptTokens = 0;
  completionTokens = 0;
  /** USD; stays null until OpenRouter reports a cost at least once. */
  cost: number | null = null;
  requests = 0;

  constructor(initial?: Partial<UsageTotals>) {
    if (initial) {
      this.promptTokens = initial.prompt_tokens ?? 0;
      this.completionTokens = initial.completion_tokens ?? 0;
      this.cost = initial.cost ?? null;
      this.requests = initial.requests ?? 0;
    }
  }

  add(usage: Usage): void {
    this.promptTokens += usage.prompt_tokens;
    this.completionTokens += usage.completion_tokens;
    if (usage.cost !== undefined) this.cost = (this.cost ?? 0) + usage.cost;
    this.requests += 1;
  }

  toJSON(): UsageTotals {
    return {
      prompt_tokens: this.promptTokens,
      completion_tokens: this.completionTokens,
      cost: this.cost,
      requests: this.requests,
    };
  }
}

export interface UsageTotals {
  prompt_tokens: number;
  completion_tokens: number;
  cost: number | null;
  requests: number;
}
