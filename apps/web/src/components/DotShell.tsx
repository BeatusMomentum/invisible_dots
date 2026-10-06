"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api } from "../lib/api";
import type { Dot } from "../lib/types";
import { PanelProvider } from "./computer/panel-state";
import { DotHeader } from "./dot/DotHeader";
import { DotTabs } from "./dot/DotTabs";
import { useLiveRefresh } from "./events";
import { useResource, type Resource } from "./ui";

interface DotContextValue {
  dotId: string;
  dot: Resource<Dot>;
}

const DotContext = createContext<DotContextValue | null>(null);

export function useDot(): DotContextValue {
  const value = useContext(DotContext);
  if (!value) throw new Error("useDot must be used inside DotShell");
  return value;
}

const HEADER_EVENTS = ["dot.updated", "computer.state", "computer.started", "computer.stopped", "agent.state"];

/**
 * The page of one Dot: its header (S4), the tab bar, and the tab's body. A tab that has not been redesigned yet puts
 * the `legacy` class on its own page; the shell does not, so a redesigned tab is never under the old stylesheet.
 *
 * The control plane accepts a Dot's name where it takes an id, but the live stream, the rail and the attention state
 * all name a Dot by its id. So an address that holds a name is replaced by the one that holds the id as soon as the
 * Dot is known, and the tab's body is not drawn under the name: everything below hears this Dot's events.
 */
export function DotShell({ dotId, children }: { dotId: string; children: ReactNode }) {
  const dot = useResource(() => api.getDot(dotId), dotId);
  useLiveRefresh(dot.reload, HEADER_EVENTS);
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const canonical = dot.data !== undefined && dot.data.id !== dotId ? dot.data.id : null;
  useEffect(() => {
    if (canonical === null) return;
    // Only the segment that names the Dot changes; the tab, a task's address and the query stay.
    const address = /^\/dots\/[^/]+/.exec(pathname);
    if (address) router.replace(`/dots/${encodeURIComponent(canonical)}${pathname.slice(address[0].length)}${window.location.search}${window.location.hash}`);
  }, [canonical, pathname, router]);

  return (
    <DotContext.Provider value={{ dotId, dot }}>
      <PanelProvider>
        <DotHeader dotId={dotId} dot={dot} />
        <DotTabs dotId={dotId} />
        <section className="mt-4">{canonical === null ? children : null}</section>
      </PanelProvider>
    </DotContext.Provider>
  );
}
