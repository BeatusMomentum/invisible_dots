"use client";

import { ANSWERED_APPROVAL_STATUSES } from "@invisible-dots/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { HISTORY_PAGE, newestHistoryPage, olderHistoryPage, type HistoryRows } from "../../lib/inbox";

export interface History {
  /** The answered approvals held so far, the last answered first; undefined until the first page is read. */
  rows: HistoryRows["rows"] | undefined;
  /** The error of the newest page (shown instead of the list) or of an older one (shown with it). */
  error: unknown;
  /** The control plane has older answers than the rows held. */
  hasMore: boolean;
  loadingMore: boolean;
  /** Read the newest page again, keeping the older rows it reaches. */
  reload: () => void;
  loadMore: () => void;
}

/**
 * The answered approvals, read from the control plane newest first one page at a time (`order=desc`, `before` the id
 * of the last one held): the list is never cut at its newest end, however many approvals the Dots have asked for.
 */
export function useHistory(): History {
  const [held, setHeld] = useState<HistoryRows | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  /** A read of the newest page is under way: an older page asked for now would be put under rows that are about to change. */
  const reloading = useRef(false);
  const current = useRef(held);
  useEffect(() => {
    current.current = held;
  });

  const reload = useCallback(() => {
    const mine = ++generation.current;
    reloading.current = true;
    setLoadingMore(false);
    api
      .listApprovals(ANSWERED_APPROVAL_STATUSES, { order: "desc", limit: HISTORY_PAGE })
      .then((page) => {
        if (mine !== generation.current) return;
        setHeld((previous) => newestHistoryPage(previous, page));
        setError(null);
      })
      .catch((err: unknown) => {
        if (mine === generation.current) setError(err);
      })
      .finally(() => {
        if (mine === generation.current) reloading.current = false;
      });
  }, []);

  const loadMore = useCallback(() => {
    const at = current.current;
    if (at?.cursor == null || reloading.current) return;
    const mine = ++generation.current;
    setLoadingMore(true);
    api
      .listApprovals(ANSWERED_APPROVAL_STATUSES, { order: "desc", limit: HISTORY_PAGE, before: at.cursor })
      .then((page) => {
        if (mine !== generation.current) return;
        setHeld((previous) => (previous === undefined ? previous : olderHistoryPage(previous, page)));
        setError(null);
      })
      .catch((err: unknown) => {
        if (mine === generation.current) setError(err);
      })
      .finally(() => {
        if (mine === generation.current) setLoadingMore(false);
      });
  }, []);

  useEffect(() => {
    reload();
    return () => void generation.current++;
  }, [reload]);

  return { rows: held?.rows, error, hasMore: held?.cursor != null, loadingMore, reload, loadMore };
}
