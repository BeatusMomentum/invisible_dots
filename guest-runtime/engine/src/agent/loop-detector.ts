// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Sliding-window loop detector for the agent conversation loop.
 *
 * Tracks tool-call signatures and text outputs across turns to detect when an
 * agent is stuck repeating the same actions. Used by {@link AgentRunner} when
 * {@link LoopDetectionConfig} is provided.
 */
import type { LoopDetectionConfig, LoopDetectionInfo } from "../types.js";

/**
 * Recursively sort object keys so that `{b:1, a:2}` and `{a:2, b:1}` produce
 * the same JSON string.
 */
export function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export class LoopDetector {
  private readonly maxRepeats: number;
  private readonly windowSize: number;

  private readonly toolSignatures: string[] = [];
  private readonly textOutputs: string[] = [];

  constructor(config: LoopDetectionConfig = {}) {
    this.maxRepeats = config.maxRepetitions ?? 3;
    const requestedWindow = config.loopDetectionWindow ?? 4;
    // Window must be >= threshold, otherwise detection can never trigger.
    this.windowSize = Math.max(requestedWindow, this.maxRepeats);
  }

  /** Record a turn's tool calls. Returns detection info when a loop is found. */
  recordToolCalls(calls: ReadonlyArray<{ name: string; input: unknown }>): LoopDetectionInfo | null {
    if (calls.length === 0) return null;
    this.push(this.toolSignatures, computeToolSignature(calls));
    const count = consecutiveRepeats(this.toolSignatures);
    if (count >= this.maxRepeats) {
      const names = calls.map((c) => c.name).join(", ");
      return {
        kind: "tool_repetition",
        repetitions: count,
        detail: `Tool call "${names}" with identical arguments has repeated ${count} times consecutively. The agent appears to be stuck in a loop.`,
      };
    }
    return null;
  }

  /** Record a turn's text output. Returns detection info when a loop is found. */
  recordText(text: string): LoopDetectionInfo | null {
    const normalised = text.trim().replace(/\s+/g, " ");
    if (normalised.length === 0) return null;
    this.push(this.textOutputs, normalised);
    const count = consecutiveRepeats(this.textOutputs);
    if (count >= this.maxRepeats) {
      return {
        kind: "text_repetition",
        repetitions: count,
        detail: `The agent has produced the same text response ${count} times consecutively. It appears to be stuck in a loop.`,
      };
    }
    return null;
  }

  /** Push an entry and trim the buffer to `windowSize`. */
  private push(buffer: string[], entry: string): void {
    buffer.push(entry);
    while (buffer.length > this.windowSize) buffer.shift();
  }
}

/**
 * Deterministic JSON signature for a set of tool calls.
 * Sorts calls by name (for multi-tool turns) and keys within each input.
 */
export function computeToolSignature(calls: ReadonlyArray<{ name: string; input: unknown }>): string {
  const items = calls
    .map((c) => ({ name: c.name, input: sortKeys(c.input) }))
    .sort((a, b) => {
      const cmp = a.name.localeCompare(b.name);
      if (cmp !== 0) return cmp;
      return JSON.stringify(a.input).localeCompare(JSON.stringify(b.input));
    });
  return JSON.stringify(items);
}

/**
 * Count how many consecutive identical entries exist at the tail of `buffer`.
 * Returns 1 when the last entry is unique.
 */
function consecutiveRepeats(buffer: readonly string[]): number {
  if (buffer.length === 0) return 0;
  const last = buffer[buffer.length - 1];
  let count = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i] === last) count++;
    else break;
  }
  return count;
}

/** The message a loop warning adds to the conversation. */
export function loopWarningText(kind: LoopDetectionInfo["kind"]): string {
  return kind === "text_repetition"
    ? "WARNING: You appear to be generating the same response repeatedly. This suggests you are stuck in a loop. Please try a different approach or provide new information."
    : "WARNING: You appear to be repeating the same tool calls with identical arguments. This suggests you are stuck in a loop. Please try a different approach, use different parameters, or explain what you are trying to accomplish.";
}
