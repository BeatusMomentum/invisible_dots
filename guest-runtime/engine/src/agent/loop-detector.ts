// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Loop detector for the agent conversation loop (architecture section 8.2).
 *
 * A round is the set of (tool, canonical arguments) of one response together
 * with the results the calls returned. When the same round comes back three
 * times in a row, the model is told once; when it happens again within the
 * unit, the unit stops. Identical calls whose results change (polling a page
 * that is still loading) are not a loop.
 *
 * Nothing is held in memory: the streak and the notices are derived from the
 * unit's own messages (from its start message), so a restart neither forgets
 * a streak nor counts a notice from an earlier chat turn.
 */
import type { ThreadMessage } from "../types.js";

/** Identical rounds in a row that count as a loop. */
export const LOOP_ROUNDS = 3;

export const LOOP_NOTICE =
  "[Notice from the agent runtime] Your last 3 rounds made the same tool calls with the same arguments and got the same results. " +
  "Repeating them will not change anything: try something different, or answer with what you have.";

export const LOOP_STOP_TEXT = `stopped: the same tool calls returned the same results ${LOOP_ROUNDS} rounds in a row`;

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

/**
 * Deterministic signature of one round: its calls sorted by name and
 * canonical arguments, each with the result it got.
 */
function roundSignature(calls: ReadonlyArray<{ name: string; input: unknown; result: string }>): string {
  const items = calls
    .map((c) => ({ name: c.name, input: sortKeys(c.input), result: c.result }))
    .sort((a, b) => {
      const cmp = a.name.localeCompare(b.name);
      if (cmp !== 0) return cmp;
      return JSON.stringify(a.input).localeCompare(JSON.stringify(b.input));
    });
  return JSON.stringify(items);
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export type LoopVerdict = "none" | "notice" | "stop";

/**
 * What the unit's messages call for before its next model request: a notice
 * the first time its last `LOOP_ROUNDS` complete rounds are identical, a stop
 * when that happens again after a notice, nothing when the notice already
 * follows the newest round. Safe to ask again after a restart.
 */
export function detectLoop(unitMessages: readonly ThreadMessage[]): LoopVerdict {
  const signatures: string[] = [];
  let noticesBefore = 0;
  let noticeAfterLast = false;
  for (let i = 0; i < unitMessages.length; i++) {
    const m = unitMessages[i]!;
    if (m.role === "user" && m.content === LOOP_NOTICE) noticeAfterLast = true;
    if (m.role !== "assistant" || !m.tool_calls || m.tool_calls.length === 0) continue;
    const results = new Map<string, string>();
    for (let j = i + 1; j < unitMessages.length && unitMessages[j]!.role === "tool"; j++) {
      const r = unitMessages[j] as Extract<ThreadMessage, { role: "tool" }>;
      results.set(r.tool_call_id, r.content);
    }
    if (results.size < m.tool_calls.length) continue; // not complete yet
    if (noticeAfterLast) noticesBefore++;
    noticeAfterLast = false;
    signatures.push(
      roundSignature(m.tool_calls.map((c) => ({ name: c.function.name, input: parseArguments(c.function.arguments), result: results.get(c.id)! }))),
    );
  }
  const last = signatures.at(-1);
  if (last === undefined || noticeAfterLast) return "none";
  let streak = 0;
  for (let i = signatures.length - 1; i >= 0 && signatures[i] === last; i--) streak++;
  if (streak < LOOP_ROUNDS) return "none";
  return noticesBefore > 0 ? "stop" : "notice";
}
