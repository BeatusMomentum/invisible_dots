"use client";

import { HomeIcon, InboxIcon, PlusIcon, SettingsIcon, UnplugIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ringState } from "../../lib/attention";
import { CHANNEL_LABELS } from "../../lib/channels";
import { dotIdFromPath, liveOf } from "../../lib/dot-live";
import { cn } from "../../lib/utils";
import { StreamIndicator } from "../events";
import { Badge } from "../ui/badge";
import { Separator } from "../ui/separator";
import { Skeleton } from "../ui/skeleton";
import { ApiStatus, MissingKeyNotice } from "./ApiStatus";
import { useShell } from "./attention";
import { DotAvatar } from "./DotAvatar";
import { ThemeToggle } from "./ThemeToggle";

/** Where a Dot is created. */
const NEW_DOT_HREF = "/new";

function NavLink({ href, current, onNavigate, children }: { href: string; current: boolean; onNavigate?: () => void; children: ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
        current && "bg-accent font-medium text-accent-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function CountBadge({ count, label }: { count: number; label: string }) {
  if (count === 0) return null;
  return (
    <Badge role="img" className="ml-auto bg-warn-soft px-1.5 text-warn" aria-label={`${count} ${label}`}>
      {count}
    </Badge>
  );
}

/**
 * The rail (S1): the brand, a way to make a Dot, the pages, every Dot with its avatar ring, and at the foot the
 * state of the API and the live stream on one line with the theme. `onNavigate` lets a sheet close itself on a click.
 */
export function Rail({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname() ?? "/";
  const { dots, attention, needsYou, live } = useShell();
  const openDotId = dotIdFromPath(path);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-2 px-2 pt-1">
        <span aria-hidden="true" className="flex gap-0.5">
          <span className="size-2 rounded-full bg-foreground" />
          <span className="size-2 rounded-full bg-foreground/50" />
          <span className="size-2 rounded-full bg-foreground/20" />
        </span>
        <span className="text-sm font-semibold tracking-tight">invisible_dots</span>
      </div>

      <nav aria-label="Main" className="space-y-0.5">
        <NavLink href="/" current={path === "/"} onNavigate={onNavigate}>
          <HomeIcon className="size-4" />
          Home
        </NavLink>
        <NavLink href="/inbox" current={path.startsWith("/inbox")} onNavigate={onNavigate}>
          <InboxIcon className="size-4" />
          Inbox
          <CountBadge count={needsYou} label="need you" />
        </NavLink>
        <NavLink href="/settings" current={path.startsWith("/settings")} onNavigate={onNavigate}>
          <SettingsIcon className="size-4" />
          Settings
        </NavLink>
      </nav>

      <Separator />

      <nav aria-label="Dots" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-xs text-muted-foreground">Dots</h2>
          <Link href={NEW_DOT_HREF} onClick={onNavigate} aria-label="New Dot" className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <PlusIcon className="size-3.5" />
          </Link>
        </div>
        {dots.data === undefined && dots.error === null ? (
          <div className="space-y-2 px-2" aria-hidden="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : null}
        {dots.error !== null && dots.data === undefined ? (
          <p className="px-2 text-xs text-danger" role="alert">
            Could not load the Dots.{" "}
            <button type="button" className="underline" onClick={dots.reload}>
              Retry
            </button>
          </p>
        ) : null}
        {dots.data?.length === 0 ? <p className="px-2 text-xs text-muted-foreground">No Dots yet.</p> : null}
        {dots.data?.map((dot) => {
          const dotAttention = attention.get(dot.id);
          const dotLive = liveOf(live, dot.id);
          const approvals = dotAttention?.pendingApprovals ?? 0;
          const relinks = dotAttention?.relinks ?? [];
          const ring = ringState({ status: dot.status, computerState: dot.computer_state, agentState: dotLive.agent, pendingApprovals: approvals });
          return (
            <Link
              key={dot.id}
              href={`/dots/${encodeURIComponent(dot.id)}/chat`}
              onClick={onNavigate}
              aria-current={openDotId === dot.id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                openDotId === dot.id && "bg-accent font-medium text-accent-foreground",
              )}
            >
              <DotAvatar id={dot.id} name={dot.name} ring={ring} size="sm" />
              <span className="min-w-0 flex-1 truncate">{dot.name}</span>
              {dotLive.unread ? <span role="img" aria-label="New reply" className="size-2 shrink-0 rounded-full bg-primary" /> : null}
              {relinks.length > 0 ? <UnplugIcon role="img" aria-label={`${relinks.map((relink) => CHANNEL_LABELS[relink.kind]).join(" and ")} needs linking again`} className="size-3.5 shrink-0 text-warn" /> : null}
              <CountBadge count={approvals} label="waiting" />
            </Link>
          );
        })}
      </nav>

      <Separator />

      <div className="space-y-1.5 px-2 pb-1">
        <div className="flex items-center gap-1">
          <ApiStatus />
          <StreamIndicator />
          <ThemeToggle />
        </div>
        <MissingKeyNotice onNavigate={onNavigate} />
      </div>
    </div>
  );
}
