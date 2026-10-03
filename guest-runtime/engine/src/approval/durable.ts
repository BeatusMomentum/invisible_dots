// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Durable tool-call approvals (architecture section 8.4).
 *
 * The approval record is the `pending_approvals` row in `dot.db`: it holds
 * the call exactly as the model made it, which is what the person decides
 * on, so an approved call runs with the arguments of the row and no second
 * copy has to be protected by a hash. A decision is one compare-and-set on
 * that row, so the first decision wins, and it keeps the person's note.
 */
import type { DotStore, PendingApprovalRecord } from "@invisible-dots/memory";
import { newId, redactToolArguments, type Permission } from "@invisible-dots/shared";
import type { TaskQueue } from "@invisible-dots/task-runtime";

export type { PendingApprovalRecord };

export interface ApprovalRequestInput {
  /** The thread the suspended call belongs to: the conversation or a task id. */
  thread: string;
  taskId: string | null;
  toolCallId: string;
  tool: string;
  permission: Permission;
  arguments: Record<string, unknown>;
  reason: string;
}

/** Outcome of recording a decision. */
export type ApprovalDecisionOutcome = "decided" | "unknown" | "already decided";

/** Primary-ledger access over `dot.db`, with atomic decision writes. */
export class DurableApprovalLedger {
  constructor(
    private readonly store: DotStore,
    private readonly queue: TaskQueue,
  ) {}

  /**
   * Record a call that waits for the person, in one transaction with its
   * `approval.requested` event and the task's move to WAITING_APPROVAL. The
   * row keeps the call whole; what leaves the guest for the host's event log
   * has its secrets replaced.
   */
  request(input: ApprovalRequestInput): PendingApprovalRecord {
    const approvalId = newId("apr");
    return this.store.transaction(() => {
      const record = this.store.insertPendingApproval({ approvalId, ...input });
      if (input.taskId) this.queue.waitForApproval(input.taskId);
      this.store.appendEvent("approval.requested", {
        approval_id: approvalId,
        ...(input.taskId ? { task_id: input.taskId } : {}),
        tool: input.tool,
        permission: input.permission,
        arguments: redactToolArguments(input.tool, input.arguments),
        reason: input.reason,
      });
      return record;
    });
  }

  get(approvalId: string): PendingApprovalRecord | undefined {
    return this.store.getApproval(approvalId);
  }

  /** The approval of a tool call, by the provider's call id. */
  forCall(toolCallId: string): PendingApprovalRecord | undefined {
    return this.store.getApprovalByToolCall(toolCallId);
  }

  /** The oldest approval still waiting for the person. */
  pending(): PendingApprovalRecord | undefined {
    return this.store.listApprovals({ status: "pending" })[0];
  }

  /** Record the person's decision and note. The first decision wins. */
  decide(approvalId: string, decision: "approve" | "reject", note: string | undefined): ApprovalDecisionOutcome {
    if (!this.store.getApproval(approvalId)) return "unknown";
    const swapped = this.store.resolveApproval(approvalId, decision === "approve" ? "approved" : "rejected", note);
    return swapped ? "decided" : "already decided";
  }

  /** Remove the row once its call has a result. */
  consume(approvalId: string): void {
    this.store.deleteApproval(approvalId);
  }

  /** Remove every approval of a thread whose unit ended. */
  dropThread(thread: string): void {
    this.store.deleteApprovalsForThread(thread);
  }
}
