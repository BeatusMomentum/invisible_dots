/**
 * What a guest event changes on the host besides the event log: task rows,
 * approval rows and the Dot's status.
 */
import type { Repositories } from "@invisible-dots/database";
import { TERMINAL_TASK_STATES, type AgentState, type DotState, type OutboundEvent } from "@invisible-dots/shared";

/**
 * The Dot status for an agent state. READY means the computer is up and the
 * agent is IDLE; DONE is the short step before IDLE (section 8.1) and still
 * counts as working.
 */
export function dotStatusForAgent(state: AgentState): DotState {
  switch (state) {
    case "IDLE":
      return "READY";
    case "WAITING_APPROVAL":
      return "WAITING_APPROVAL";
    default:
      return "RUNNING";
  }
}

/** Dot states the agent's own reports never override: they are set by the control plane. */
const STICKY_DOT_STATES: readonly DotState[] = ["CREATING", "ERROR", "DISABLED", "IDLE"];

export interface AppliedGuestEvent {
  /** A task reached a terminal state, so the Dot may take the next one. */
  taskSettled: boolean;
}

/** Apply one newly stored guest event inside the transaction that stored it. */
export async function applyGuestEvent(tx: Repositories, dotId: string, event: OutboundEvent): Promise<AppliedGuestEvent> {
  switch (event.type) {
    case "agent.state": {
      const dot = await tx.dots.get(dotId);
      if (dot && !STICKY_DOT_STATES.includes(dot.status)) {
        const next = dotStatusForAgent(event.data.state);
        if (next !== dot.status) await tx.dots.setStatus(dotId, next);
      }
      return { taskSettled: false };
    }
    case "task.started":
      await tx.tasks.transition(event.data.task_id, "RUNNING", { dotId });
      return { taskSettled: false };
    case "task.completed":
      return { taskSettled: (await tx.tasks.transition(event.data.task_id, "COMPLETED", { summary: event.data.summary, dotId })) !== null };
    case "task.failed":
      return { taskSettled: (await tx.tasks.transition(event.data.task_id, "FAILED", { error: event.data.error, dotId })) !== null };
    case "approval.requested": {
      // A request for a task that already ended (cancelled while the guest
      // was asking) is kept for the record but never listed as pending.
      const task = event.data.task_id ? await tx.tasks.get(event.data.task_id) : null;
      const ended = task !== null && task.dot_id === dotId && TERMINAL_TASK_STATES.includes(task.status);
      await tx.approvals.insertRequested(dotId, event.data, ended ? "expired" : "pending");
      if (event.data.task_id && !ended) await tx.tasks.transition(event.data.task_id, "WAITING_APPROVAL", { dotId });
      return { taskSettled: false };
    }
    default:
      return { taskSettled: false };
  }
}
