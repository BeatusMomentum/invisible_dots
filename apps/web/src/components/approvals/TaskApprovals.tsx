"use client";

import { useMemo } from "react";
import { askOfRecord } from "../../lib/approval-view";
import { waitingOrder } from "../../lib/inbox";
import { useShell } from "../shell/attention";
import { ApprovalCard } from "./ApprovalCard";
import { useApprovalAnswers } from "./use-answers";

/**
 * The approvals a task is waiting on, as cards the person answers where the task is (its card, its drawer). One that
 * was answered here stays as a receipt for as long as the task's page is open, though the host no longer lists it as waiting.
 */
export function TaskApprovals({ taskId }: { taskId: string }) {
  const { approvals } = useShell();
  const answers = useApprovalAnswers();
  const asks = useMemo(() => {
    const waiting = (approvals.data ?? []).filter((a) => a.task_id === taskId && a.status === "pending").map(askOfRecord);
    const listed = new Set(waiting.map((ask) => ask.id));
    const kept = [...answers.settled.values()].map((settled) => settled.ask).filter((ask) => ask.taskId === taskId && !listed.has(ask.id));
    return waitingOrder([...waiting, ...kept]);
  }, [approvals.data, answers.settled, taskId]);

  if (asks.length === 0) return null;
  return (
    <ul aria-label="Waiting for your answer" className="space-y-3">
      {asks.map((ask) => (
        <li key={ask.id}>
          <ApprovalCard ask={ask} answers={answers} />
        </li>
      ))}
    </ul>
  );
}
