"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";
import { api } from "../lib/api";
import type { Dot } from "../lib/types";
import { StreamIndicator, useLiveRefresh } from "./events";
import { ErrorBox, StatusBadge, useResource, type Resource } from "./ui";

export const DOT_TABS = [
  { slug: "chat", label: "Chat" },
  { slug: "tasks", label: "Tasks" },
  { slug: "timeline", label: "Timeline" },
  { slug: "approvals", label: "Approvals" },
  { slug: "identities", label: "Browser identities" },
  { slug: "computer", label: "Computer" },
  { slug: "settings", label: "Settings" },
] as const;

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

export function DotShell({ dotId, children }: { dotId: string; children: ReactNode }) {
  const dot = useResource(() => api.getDot(dotId), dotId);
  useLiveRefresh(dot.reload, HEADER_EVENTS);
  const path = usePathname() ?? "";
  const base = `/dots/${encodeURIComponent(dotId)}`;

  return (
    <DotContext.Provider value={{ dotId, dot }}>
      <div className="page-head">
        <h1>{dot.data?.name ?? dotId}</h1>
        {dot.data ? <StatusBadge status={dot.data.status} label="Dot status" /> : null}
        {dot.data?.computer_state ? <StatusBadge status={dot.data.computer_state} label="Computer" /> : null}
        <StreamIndicator />
      </div>
      {dot.data?.config?.goal ? <p className="goal">{dot.data.config.goal}</p> : null}
      <ErrorBox error={dot.error} title="Could not load this Dot" />
      <nav aria-label="Dot sections" className="tabs">
        <ul>
          {DOT_TABS.map((tab) => {
            const href = `${base}/${tab.slug}`;
            const current = path === href || path.startsWith(`${href}/`);
            return (
              <li key={tab.slug}>
                <Link href={href} aria-current={current ? "page" : undefined}>
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <section className="tab-panel">{children}</section>
    </DotContext.Provider>
  );
}
