// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Token estimates for a request, without a tokenizer (architecture section 8.6).
 *
 * Characters convert to tokens at `max(1/3, the last measured ratio for this
 * model)`: the ratio is a response's `prompt_tokens` over the characters of
 * the request that produced it, kept in memory, so it is pessimistic again
 * after a restart. Each image costs a fixed number of tokens.
 */
import type { ChatMessage, FunctionTool } from "@invisible-dots/openrouter-client";

/** Tokens charged for each image part. */
export const IMAGE_TOKENS = 1600;

/** The floor of the ratio: three characters per token, pessimistic for any text a Dot sees. */
export const MIN_TOKENS_PER_CHAR = 1 / 3;

/** Characters of a request, image payloads left out, and its number of images. */
export function requestShape(messages: readonly ChatMessage[], tools?: readonly FunctionTool[]): { chars: number; images: number } {
  let images = 0;
  const text = JSON.stringify(messages, (key, value: unknown) => {
    if (key === "image_url") {
      images++;
      return "";
    }
    return value;
  });
  return { chars: text.length + (tools && tools.length > 0 ? JSON.stringify(tools).length : 0), images };
}

export class TokenEstimator {
  readonly #ratios = new Map<string, number>();

  /** Tokens per character for `model`, never below the floor. */
  ratio(model: string): number {
    return Math.max(MIN_TOKENS_PER_CHAR, this.#ratios.get(model) ?? 0);
  }

  /** Estimated prompt tokens of a request. */
  estimate(model: string, messages: readonly ChatMessage[], tools?: readonly FunctionTool[]): number {
    const shape = requestShape(messages, tools);
    return Math.ceil(shape.chars * this.ratio(model)) + shape.images * IMAGE_TOKENS;
  }

  /** Estimated tokens of a piece of text. */
  textTokens(model: string, text: string): number {
    return Math.ceil(text.length * this.ratio(model));
  }

  /** Characters that fit in `tokens`. */
  charsFor(model: string, tokens: number): number {
    return Math.floor(tokens / this.ratio(model));
  }

  /** Learn the ratio from what the provider counted for a request. */
  calibrate(model: string, messages: readonly ChatMessage[], tools: readonly FunctionTool[] | undefined, promptTokens: number): void {
    const shape = requestShape(messages, tools);
    const textTokens = promptTokens - shape.images * IMAGE_TOKENS;
    if (shape.chars > 0 && textTokens > 0) this.#ratios.set(model, textTokens / shape.chars);
  }
}
