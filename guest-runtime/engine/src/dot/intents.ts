/**
 * Calls a crash interrupted (architecture section 8.7).
 *
 * Before a tool runs, its intent is committed; with its result, the intent is
 * deleted. An intent found when a unit is entered, for a call that is not
 * executing in this process, is a call whose outcome is unknown: it may have
 * taken effect, and it may still be running. A replay-safe call runs once
 * more; anything else, and a replay-safe call that already stopped the agent
 * twice, is reported to the model and the host as interrupted.
 */
import type { ToolIntentRecord } from "@invisible-dots/memory";
import { getTool } from "@invisible-dots/shared";

export type IntentVerdict = "run again" | "interrupted" | "interrupted twice";

export function classifyIntent(intent: ToolIntentRecord): IntentVerdict {
  if (getTool(intent.tool)?.replaySafe !== true) return "interrupted";
  return intent.attempts >= 2 ? "interrupted twice" : "run again";
}

/** The result the model reads for an interrupted call. */
export function interruptedText(verdict: Exclude<IntentVerdict, "run again">, approvalUsed: boolean): string {
  const lines = [
    "This call was interrupted before its result was recorded. It may have taken effect, and it may still be running. Check the current state before calling it again.",
  ];
  if (verdict === "interrupted twice") lines.push("It stopped the agent twice, so it was not run a third time.");
  if (approvalUsed) lines.push("The user's approval was used by that attempt; calling it again asks again.");
  return lines.join(" ");
}

/** The key of a call in the intents table and in the set of calls executing now. */
export function callKey(thread: string, messageId: number, callIndex: number): string {
  return `${thread}\u0000${messageId}\u0000${callIndex}`;
}
