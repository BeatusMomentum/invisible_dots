"use client";

import type { ApprovalAsk } from "../../lib/approval-view";
import { ApprovalCard } from "./ApprovalCard";
import { useApprovalAnswers } from "./use-answers";

/** An approval card in the page that asked (the chat, a task): it answers for itself. */
export function InlineApproval({ ask }: { ask: ApprovalAsk }) {
  const answers = useApprovalAnswers();
  return <ApprovalCard ask={ask} answers={answers} className="my-2" />;
}
