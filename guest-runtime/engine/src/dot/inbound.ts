/**
 * Inbound events (architecture section 5.4): one `apply` for every event the
 * guest accepted, run inside the transaction that records it. Whatever must
 * happen outside the database (aborting the unit in flight, saying the Dot is
 * idle) comes back as post-commit actions, which run only after COMMIT: a
 * transaction that rolls back has changed nothing and aborted nothing.
 *
 * A `user.message` is not applied here: it stays pending in the inbox until
 * its chat turn is answered.
 */
import type { DotStore, InboxEntry } from "@invisible-dots/memory";
import { TASK_CANCELLED_SYSTEM_EVENT } from "@invisible-dots/shared";
import type { TaskQueue } from "@invisible-dots/task-runtime";
import type { DurableApprovalLedger } from "../approval/durable.js";
import type { Checkpoint } from "../memory/checkpoint.js";
import type { RunLedger } from "../run/ledger.js";
import type { Logger } from "../types.js";

/** What the driver does once the transaction committed. */
export type PostCommitAction =
  /** The task of the unit in flight was cancelled: abort the running unit. */
  | { kind: "abort-unit"; taskId: string }
  /** The task of the active unit was cancelled while nothing ran: the unit is gone. */
  | { kind: "unit-dropped"; taskId: string };

export interface InboundContext {
  store: DotStore;
  queue: TaskQueue;
  approvals: DurableApprovalLedger;
  ledger: RunLedger;
  checkpoint: Checkpoint;
  log: Logger;
  /** True while a unit is running in this process. */
  running(): boolean;
}

/** Apply one accepted, unprocessed, non-chat inbox row. Call inside a transaction. */
export function applyInbound(ctx: InboundContext, row: Pick<InboxEntry, "id" | "type" | "data">): PostCommitAction[] {
  const actions: PostCommitAction[] = [];
  const data = row.data;
  switch (row.type) {
    case "user.message":
      return actions;
    case "task.created": {
      const taskId = String(data.task_id ?? "");
      const { created } = ctx.queue.enqueue({
        id: taskId,
        description: String(data.description ?? ""),
        priority: typeof data.priority === "number" ? data.priority : 0,
      });
      if (!created) ctx.log.warn("task already known, not queued again", { task_id: taskId });
      break;
    }
    case "approval.received": {
      const approvalId = String(data.approval_id ?? "");
      const decision = data.decision === "approve" ? "approve" : "reject";
      const outcome = ctx.approvals.decide(approvalId, decision, typeof data.note === "string" ? data.note : undefined);
      if (outcome === "unknown") ctx.log.warn("approval.received for an unknown approval; ignored", { approval_id: approvalId });
      else if (outcome === "already decided") ctx.log.warn("approval.received for an approval already resolved; ignored", { approval_id: approvalId });
      else ctx.log.info("approval resolved", { approval_id: approvalId, decision });
      break;
    }
    case "system.event": {
      const name = String(data.name ?? "");
      if (name === TASK_CANCELLED_SYSTEM_EVENT) {
        const inner = (data.data ?? {}) as Record<string, unknown>;
        actions.push(...cancelTask(ctx, typeof inner.task_id === "string" ? inner.task_id : ""));
      } else {
        ctx.log.info("system event recorded", { name });
      }
      break;
    }
  }
  ctx.store.markInboundProcessed(row.id);
  return actions;
}

function cancelTask(ctx: InboundContext, taskId: string): PostCommitAction[] {
  const cancelled = ctx.queue.cancel(taskId);
  if (!cancelled) {
    ctx.log.warn("cancel for a task that is unknown or already finished; ignored", { task_id: taskId });
    return [];
  }
  ctx.approvals.dropThread(taskId);
  ctx.log.info("task cancelled", { task_id: taskId });
  const active = ctx.ledger.get();
  if (active?.kind !== "task" || active.taskId !== taskId) return [];
  if (ctx.running()) return [{ kind: "abort-unit", taskId }];
  // Not running: it was waiting for an approval, or for the next start.
  ctx.checkpoint.drop(active);
  return [{ kind: "unit-dropped", taskId }];
}
