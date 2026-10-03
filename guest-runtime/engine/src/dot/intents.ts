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
import type { DotStore, StoredMessage, ToolIntentRecord } from "@invisible-dots/memory";
import { getTool } from "@invisible-dots/shared";
import type { RunLedger } from "../run/ledger.js";
import { threadOf } from "../run/record.js";
import type { Logger, ThreadMessage } from "../types.js";
import { NOT_EXECUTED_TEXT, openCalls } from "./request.js";

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
  return `${thread}:${messageId}:${callIndex}`;
}

/** The config row that says the first-start pass ran on this database. */
export const FIRST_START_FLAG = "engine_first_start_done";

/**
 * The first start on this engine, over a `dot.db` the older code wrote
 * (architecture section 8.7). Triggered by the absence of the flag, not by
 * the migration, so a crash between the two cannot skip it; the last step
 * commits with the flag. The inbound replay (step 1) has run already;
 * `resolvedByReplay` holds the approvals it decided.
 *
 *  2. Old approvals get the position of their call.
 *  3. Calls left without a result anywhere but in the active unit's newest
 *     assistant message are answered `Not executed` (or, in the middle of a
 *     thread, where no result can follow them any more, removed from their
 *     message: they never ran).
 *  4. The older code ran calls in order and committed each, so only the
 *     first open call of the active unit can have run without its result
 *     being recorded. It gets an intent (`attempts = 1`) unless its approval
 *     is pending, rejected or was decided by the replay, in which case it
 *     provably never ran; the usual classification then applies.
 */
export function firstStartPass(store: DotStore, ledger: RunLedger, resolvedByReplay: ReadonlySet<string>, log: Logger): void {
  if (store.getConfig(FIRST_START_FLAG) !== undefined) return;
  log.info("first start on this engine: checking the database left by the previous version");

  store.transaction(() => {
    for (const approval of store.listApprovals()) {
      if (approval.messageId !== null) continue;
      const position = findCall(store.listMessages<ThreadMessage>(approval.thread), approval.toolCallId);
      if (position) store.setApprovalPosition(approval.approvalId, position.messageId, position.callIndex);
    }
  });

  const active = ledger.get();
  const activeThread = active ? threadOf(active) : null;
  for (const thread of store.listThreads()) {
    store.transaction(() => repairThread(store, thread, thread === activeThread, log));
  }

  store.transaction(() => {
    if (active) {
      const thread = threadOf(active);
      const messages = store.listMessages<ThreadMessage>(thread);
      if (active.startMessageId === 0) ledger.setStartMessage(startOf(active.kind, messages));
      const open = openCalls(messages);
      const first = open?.calls[0];
      if (open && first) {
        const approval = store.getApprovalByCall(thread, open.messageId, first.index);
        const neverRan = approval !== undefined && (approval.status !== "approved" || resolvedByReplay.has(approval.approvalId));
        if (!neverRan) {
          store.recordIntent({
            thread,
            messageId: open.messageId,
            callIndex: first.index,
            toolCallId: first.call.id,
            tool: first.call.function.name,
            permission: getTool(first.call.function.name)?.permission ?? "",
            decision: approval ? "ask" : "allow",
          });
          log.warn("the previous version may have stopped during a call", { tool: first.call.function.name, thread });
        }
      }
    }
    store.setConfig(FIRST_START_FLAG, true);
  });
}

function findCall(messages: readonly StoredMessage<ThreadMessage>[], toolCallId: string): { messageId: number; callIndex: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!.message;
    if (m.role !== "assistant") continue;
    const index = (m.tool_calls ?? []).findIndex((c) => c.id === toolCallId);
    if (index >= 0) return { messageId: messages[i]!.id, callIndex: index };
  }
  return undefined;
}

function startOf(kind: "chat" | "task", messages: readonly StoredMessage<ThreadMessage>[]): number {
  if (kind === "task") return messages[0]?.id ?? 0;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.message.role === "user") return messages[i]!.id;
  return 0;
}

function repairThread(store: DotStore, thread: string, active: boolean, log: Logger): void {
  const messages = store.listMessages<ThreadMessage>(thread);
  for (let i = 0; i < messages.length; i++) {
    const stored = messages[i]!;
    const m = stored.message;
    if (m.role !== "assistant" || !m.tool_calls || m.tool_calls.length === 0) continue;
    let end = i + 1;
    const answered = new Set<string>();
    while (end < messages.length && messages[end]!.message.role === "tool") {
      answered.add((messages[end]!.message as { tool_call_id: string }).tool_call_id);
      end++;
    }
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    if (missing.length === 0) continue;
    if (end === messages.length) {
      // The newest assistant message: its results can still follow it.
      if (active) continue;
      for (const call of missing) store.appendMessage<ThreadMessage>(thread, { role: "tool", tool_call_id: call.id, content: NOT_EXECUTED_TEXT });
    } else {
      const kept = m.tool_calls.filter((c) => answered.has(c.id));
      store.replaceMessage<ThreadMessage>(stored.id, kept.length > 0 ? { ...m, tool_calls: kept } : { role: "assistant", content: m.content ?? "" });
    }
    log.warn("answered calls the previous version left open", { thread, calls: missing.length });
  }
}
