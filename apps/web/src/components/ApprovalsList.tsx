"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import type { Approval } from "../lib/types";
import { useLiveRefresh } from "./events";
import { ErrorBox, useAction, useResource } from "./ui";

const APPROVAL_EVENTS = ["approval.requested", "approval.resolved"];

/** Pending approvals, for one Dot when `dotId` is given, otherwise for all of them. */
export function ApprovalsList({ dotId }: { dotId?: string }) {
  const approvals = useResource(async () => {
    const all = await api.listApprovals("pending");
    return dotId ? all.filter((a) => a.dot_id === dotId) : all;
  }, `approvals:${dotId ?? "*"}`);
  // Names for the global list; a failure here only costs the names.
  const dots = useResource(() => (dotId ? Promise.resolve([]) : api.listDots()), `approval-dots:${dotId ?? "*"}`);
  useLiveRefresh(approvals.reload, APPROVAL_EVENTS);

  const names = new Map((dots.data ?? []).map((d) => [d.id, d.name]));

  return (
    <>
      <ErrorBox error={approvals.error} title="Could not load approvals" />
      {approvals.data && approvals.data.length === 0 ? <p className="muted">Nothing is waiting for an approval.</p> : null}
      <ul className="approvals">
        {approvals.data?.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            dotName={dotId ? undefined : (names.get(approval.dot_id) ?? approval.dot_id)}
            onResolved={approvals.reload}
          />
        ))}
      </ul>
    </>
  );
}

function ApprovalCard({
  approval,
  dotName,
  onResolved,
}: {
  approval: Approval;
  dotName?: string;
  onResolved: () => void;
}) {
  const [note, setNote] = useState("");
  const action = useAction();
  const noteId = `note-${approval.id}`;

  async function resolve(decision: "approve" | "reject") {
    const ok = await action.run(() => decision === "approve" ? api.approve(approval.id, note.trim() || undefined) : api.reject(approval.id, note.trim() || undefined));
    if (ok) onResolved();
  }

  return (
    <li className="card approval">
      <div className="approval-head">
        <strong>
          <code>{approval.tool}</code>
        </strong>
        <span className="badge tone-warn">{approval.permission}</span>
        {dotName ? (
          <Link href={`/dots/${encodeURIComponent(approval.dot_id)}/approvals`}>{dotName}</Link>
        ) : null}
        <time className="muted small" dateTime={approval.created_at}>
          {formatDate(approval.created_at)}
        </time>
      </div>
      {approval.reason ? <p>{approval.reason}</p> : null}
      {approval.task_id ? (
        <p className="muted small">
          Task <code>{approval.task_id}</code>
        </p>
      ) : null}
      <details>
        <summary>Arguments</summary>
        <pre className="code-block">{JSON.stringify(approval.arguments ?? {}, null, 2)}</pre>
      </details>
      <label htmlFor={noteId}>Note for the Dot (optional)</label>
      <input id={noteId} type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="actions">
        <button type="button" disabled={action.pending} onClick={() => void resolve("approve")}>
          Approve
        </button>
        <button type="button" className="danger" disabled={action.pending} onClick={() => void resolve("reject")}>
          Reject
        </button>
      </div>
      <ErrorBox error={action.error} title="The decision was not recorded" />
    </li>
  );
}
