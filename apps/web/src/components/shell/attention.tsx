"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { attentionByDot, needsYouCount, NO_ATTENTION, pendingApprovalCount, withTitlePrefix, type DotAttention } from "../../lib/attention";
import { applyLiveEvent, dismissRestart, dotIdFromPath, liveOf, markRead, type LiveDot, type LiveDots } from "../../lib/dot-live";
import { faviconHref } from "../../lib/favicon";
import type { Approval, Dot } from "../../lib/types";
import { useLiveEvents, useLiveRefresh } from "../events";
import { useResource, type Resource } from "../ui";

const DOT_EVENTS = ["dot.created", "dot.updated", "dot.deleted", "computer.state", "computer.started", "computer.stopped"];
const APPROVAL_EVENTS = ["approval.requested", "approval.resolved", "task.cancelled", "task.completed", "task.failed"];

interface ShellData {
  dots: Resource<Dot[]>;
  approvals: Resource<Approval[]>;
  attention: ReadonlyMap<string, DotAttention>;
  /** Waiting approvals of every Dot. */
  pendingApprovals: number;
  live: LiveDots;
  dismissRestart: (dotId: string) => void;
}

const Context = createContext<ShellData | null>(null);

/**
 * What every signed-in page shares: the Dots, the approvals that wait, and what the live stream says about each
 * Dot. The rail, the Dot header, the document title and the favicon all read it, so they agree and the control
 * plane is asked once, not once per component.
 */
export function AttentionProvider({ children }: { children: ReactNode }) {
  const dots = useResource(() => api.listDots(), "shell:dots");
  const approvals = useResource(() => api.listApprovals("pending"), "shell:approvals");
  useLiveRefresh(dots.reload, DOT_EVENTS);
  useLiveRefresh(approvals.reload, APPROVAL_EVENTS);

  const openDotId = dotIdFromPath(usePathname() ?? "");
  const [live, setLive] = useState<LiveDots>({});
  useLiveEvents((event) => setLive((current) => applyLiveEvent(current, event, openDotId)));
  useEffect(() => {
    if (openDotId) setLive((current) => markRead(current, openDotId));
  }, [openDotId]);

  const attention = useMemo(() => attentionByDot(dots.data ?? [], approvals.data ?? []), [dots.data, approvals.data]);
  const needsYou = needsYouCount(attention);
  useTitleAndFavicon(needsYou);

  const dismiss = useCallback((dotId: string) => setLive((current) => dismissRestart(current, dotId)), []);
  const value = useMemo<ShellData>(
    () => ({ dots, approvals, attention, pendingApprovals: pendingApprovalCount(attention), live, dismissRestart: dismiss }),
    [dots, approvals, attention, live, dismiss],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useShell(): ShellData {
  const value = useContext(Context);
  if (!value) throw new Error("useShell must be used inside AttentionProvider");
  return value;
}

export function useDotAttention(dotId: string): DotAttention {
  return useShell().attention.get(dotId) ?? NO_ATTENTION;
}

export function useDotLive(dotId: string): LiveDot {
  return liveOf(useShell().live, dotId);
}

/** "(3) " in the tab title and a second dot on the favicon while something needs the person. */
function useTitleAndFavicon(needsYou: number): void {
  useEffect(() => {
    const apply = () => {
      const next = withTitlePrefix(document.title, needsYou);
      if (next !== document.title) document.title = next;
    };
    apply();
    // Next writes a new title on every navigation: put the prefix back each time.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = withTitlePrefix(document.title, 0);
    };
  }, [needsYou]);

  const attentive = needsYou > 0;
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = faviconHref(attentive);
    document.head.append(link);
    return () => link.remove();
  }, [attentive]);
}
