"use client";

import Link from "next/link";
import { ringState } from "../../lib/attention";
import { taskRunning } from "../../lib/computer";
import { cardStatus } from "../../lib/dot-card";
import type { Dot } from "../../lib/types";
import { cn } from "../../lib/utils";
import { CostPill } from "../dot/CostPill";
import { PowerMenu } from "../dot/PowerMenu";
import { TONE_DOT } from "../dot/tone";
import { useDotAttention, useDotLive, useShell } from "../shell/attention";
import { DotAvatar } from "../shell/DotAvatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { LastActivity } from "./last-activity";

/**
 * A Dot on the Home page: who it is and what it is for, what state it is in (and why, when that is an error), its
 * model, what it spent today, the approvals that wait for the person, and the two things the person most often
 * wants to do: open its chat, and start or stop its computer.
 */
export function DotCard({ dot }: { dot: Dot }) {
  const { dots } = useShell();
  const { pendingApprovals } = useDotAttention(dot.id);
  const live = useDotLive(dot.id);
  const status = cardStatus(dot, live.agent);
  const ring = ringState({ status: dot.status, computerState: dot.computer_state, agentState: live.agent, pendingApprovals });
  const href = `/dots/${encodeURIComponent(dot.id)}`;
  const model = dot.config?.model?.id;

  return (
    <article aria-labelledby={`dot-${dot.id}-name`} className="grid gap-x-6 gap-y-2 px-4 py-4 md:grid-cols-[minmax(12rem,16rem)_1fr_auto] md:items-center">
      <div className="flex items-center gap-3">
        <DotAvatar id={dot.id} name={dot.name} ring={ring} size="sm" />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id={`dot-${dot.id}-name`} className="truncate text-sm leading-tight font-semibold">
            <Link href={`${href}/chat`} className="hover:underline">
              {dot.name}
            </Link>
          </h2>
          <p className={cn("flex w-fit items-center gap-1.5 text-xs text-muted-foreground", status.working && "animate-pulse motion-reduce:animate-none")}>
            <span aria-hidden="true" className={cn("size-2 rounded-full", TONE_DOT[status.tone])} />
            <span className="sr-only">Status: </span>
            {status.label}
          </p>
        </div>
        {pendingApprovals > 0 ? (
          <Link href={`/inbox?dot=${encodeURIComponent(dot.id)}`} aria-label={`${pendingApprovals} ${pendingApprovals === 1 ? "approval" : "approvals"} waiting`}>
            <Badge className="bg-warn-soft text-warn">{pendingApprovals} waiting</Badge>
          </Link>
        ) : null}
      </div>

      <div className="min-w-0 space-y-1">
        {status.reason ? <p className="text-sm text-danger">{status.reason}</p> : null}
        <p className="line-clamp-2 text-sm text-muted-foreground">{dot.config?.goal ?? ""}</p>

      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {model ? (
          <div className="flex gap-1">
            <dt className="sr-only">Model</dt>
            <dd className="font-mono">{model}</dd>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <dt>Spent today</dt>
          <dd>
            <CostPill dotId={dot.id} />
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>Last activity</dt>
          <LastActivity dotId={dot.id} />
        </div>
      </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <Button asChild size="sm" variant="outline">
          <Link href={`${href}/chat`}>Open chat</Link>
        </Button>
        <PowerMenu dotId={dot.id} computerState={dot.computer_state} taskRunning={taskRunning(dot.status)} onDone={dots.reload} />
      </div>
    </article>
  );
}
