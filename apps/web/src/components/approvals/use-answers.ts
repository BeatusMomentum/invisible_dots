"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { ApprovalAsk, Receipt } from "../../lib/approval-view";
import { useShell } from "../shell/attention";

/** An approval this page has seen answered: by this person here, or (409) by someone else while it was open. */
export interface Settled {
  ask: ApprovalAsk;
  receipt: Receipt;
  /** The answer also set the permission to allow, for good. */
  always: boolean;
  note: string;
}

export interface Answers {
  /** Approvals whose answer is on its way. */
  sending: ReadonlySet<string>;
  /** Why an answer was not recorded, by approval id. */
  errors: ReadonlyMap<string, unknown>;
  settled: ReadonlyMap<string, Settled>;
  /** The note the person is writing for an approval, kept here so an answer made from the keyboard sends it too. */
  noteOf: (id: string) => string;
  setNote: (id: string, note: string) => void;
  /** Allow (once, or for good) or deny. An approval whose answer is on its way ignores a second one. */
  answer: (ask: ApprovalAsk, decision: "approve" | "reject", options?: { always?: boolean }) => Promise<void>;
}

/**
 * Answering approvals from one place on the page. The control plane records the first answer and refuses the others
 * with 409 `already_resolved`: that is not a failure of this answer but the news that someone (another tab, a Telegram
 * chat) was first, and it is said so. Whatever the outcome, the shell's list of waiting approvals is read again.
 */
export function useApprovalAnswers(): Answers {
  const { approvals } = useShell();
  const reloadApprovals = approvals.reload;
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, unknown>>(new Map());
  const [settled, setSettled] = useState<ReadonlyMap<string, Settled>>(new Map());
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(new Map());
  const inFlight = useRef(new Set<string>());
  const notesRef = useRef(notes);
  useEffect(() => {
    notesRef.current = notes;
  });

  const setNote = useCallback((id: string, note: string) => setNotes((current) => new Map(current).set(id, note)), []);
  const noteOf = useCallback((id: string) => notes.get(id) ?? "", [notes]);

  const answer = useCallback(
    async (ask: ApprovalAsk, decision: "approve" | "reject", options: { always?: boolean } = {}) => {
      if (inFlight.current.has(ask.id)) return;
      inFlight.current.add(ask.id);
      setSending((current) => new Set(current).add(ask.id));
      setErrors((current) => {
        const next = new Map(current);
        next.delete(ask.id);
        return next;
      });
      const note = (notesRef.current.get(ask.id) ?? "").trim();
      const always = decision === "approve" && options.always === true;
      const settle = (receipt: Receipt) => setSettled((current) => new Map(current).set(ask.id, { ask, receipt, always, note }));
      try {
        const body = { ...(note !== "" ? { note } : {}), ...(always ? { always: true as const } : {}) };
        await (decision === "approve" ? api.approve(ask.id, body) : api.reject(ask.id, body));
        settle(decision === "approve" ? "approved" : "rejected");
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.code === "already_resolved") settle("elsewhere");
        else setErrors((current) => new Map(current).set(ask.id, error));
      } finally {
        inFlight.current.delete(ask.id);
        setSending((current) => {
          const next = new Set(current);
          next.delete(ask.id);
          return next;
        });
        reloadApprovals();
      }
    },
    [reloadApprovals],
  );

  return useMemo(() => ({ sending, errors, settled, noteOf, setNote, answer }), [sending, errors, settled, noteOf, setNote, answer]);
}
