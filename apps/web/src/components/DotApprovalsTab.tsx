"use client";

import { ApprovalsList } from "./ApprovalsList";
import { useDot } from "./DotShell";

export function DotApprovalsTab() {
  const { dotId } = useDot();
  return (
    <>
      <h2>Pending approvals</h2>
      <ApprovalsList dotId={dotId} />
    </>
  );
}
