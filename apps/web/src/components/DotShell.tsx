"use client";

import { createContext, useContext, type ReactNode } from "react";
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
 */
export function DotShell({ dotId, children }: { dotId: string; children: ReactNode }) {
  const dot = useResource(() => api.getDot(dotId), dotId);
  useLiveRefresh(dot.reload, HEADER_EVENTS);

  return (
    <DotContext.Provider value={{ dotId, dot }}>
      <PanelProvider>
        <DotHeader dotId={dotId} dot={dot} />
        <DotTabs dotId={dotId} />
        <section className="mt-4">{children}</section>
      </PanelProvider>
    </DotContext.Provider>
  );
}
