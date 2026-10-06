"use client";

import { AlertCircleIcon, InfoIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { statePill } from "../../lib/agent";
import { ringState } from "../../lib/attention";
import { api } from "../../lib/api";
import { taskRunning } from "../../lib/computer";
import { cn } from "../../lib/utils";
import type { Dot } from "../../lib/types";
import { ErrorBox, useResource, type Resource } from "../ui";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { useDotAttention, useDotLive, useShell } from "../shell/attention";
import { DotAvatar } from "../shell/DotAvatar";
import { CostPill } from "./CostPill";
import { PowerMenu } from "./PowerMenu";
import { TONE_CLASS } from "./tone";

/**
 * The Dot header (S4): its avatar, name and goal; the state it is in, what it cost today, and its computer with
 * the power menu; and under it the banners that say why a Dot is in ERROR or that its agent was restarted.
 */
export function DotHeader({ dotId, dot }: { dotId: string; dot: Resource<Dot> }) {
  const { pendingApprovals } = useDotAttention(dotId);
  const live = useDotLive(dotId);
  const { dismissRestart } = useShell();
  const [goalOpen, setGoalOpen] = useState(false);
  const record = dot.data;

  const hasError = record !== undefined && (record.status === "ERROR" || record.computer_state === "ERROR");
  // The computer's own last error explains an ERROR; asked only then.
  const computer = useResource(() => (hasError ? api.computer(dotId) : Promise.resolve(null)), `computer-error:${dotId}:${hasError}`);

  if (record === undefined) {
    return (
      <header className="space-y-3" aria-busy={dot.loading}>
        <ErrorBox error={dot.error} title="Could not load this Dot" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 rounded-full" />
          <Skeleton className="h-6 w-48" />
        </div>
      </header>
    );
  }

  const pill = statePill(record.status, live.agent);
  const ring = ringState({ status: record.status, computerState: record.computer_state, agentState: live.agent, pendingApprovals });
  const goal = record.config?.goal ?? "";
  const pillClass = cn("rounded-full px-2.5 py-0.5 text-xs font-medium", TONE_CLASS[pill.tone], pill.working && "animate-pulse");

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <DotAvatar id={record.id} name={record.name} ring={ring} size="lg" />
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="truncate text-xl font-semibold tracking-tight">{record.name}</h1>
          {goal ? (
            <button
              type="button"
              onClick={() => setGoalOpen((open) => !open)}
              aria-expanded={goalOpen}
              title={goalOpen ? "Show less" : "Show the whole goal"}
              className={cn("block max-w-full text-left text-sm text-muted-foreground", goalOpen ? "whitespace-pre-wrap" : "truncate")}
            >
              {goal}
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pill.label === "Waiting for you" ? (
            <Link href={`/dots/${encodeURIComponent(dotId)}/approvals`} className={cn(pillClass, "underline-offset-2 hover:underline")}>
              <span className="sr-only">Dot state: </span>
              {pill.label}
            </Link>
          ) : (
            <span className={pillClass}>
              <span className="sr-only">Dot state: </span>
              {pill.label}
            </span>
          )}
          <CostPill dotId={dotId} />
          <PowerMenu dotId={dotId} computerState={record.computer_state} taskRunning={taskRunning(record.status)} onDone={dot.reload} />
        </div>
      </div>

      {hasError ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{record.status === "ERROR" ? "This Dot is in an error state" : "The computer is in an error state"}</AlertTitle>
          <AlertDescription>
            {record.error ? <p>{record.error}</p> : null}
            {computer.data?.last_error ? <p>Computer: {computer.data.last_error}</p> : null}
            <div className="mt-1 flex gap-2">
              <Button asChild variant="outline" size="xs">
                <Link href={`/dots/${encodeURIComponent(dotId)}/settings`}>Open settings</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {live.restarted ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>Interrupted, restarted</AlertTitle>
          <AlertDescription>
            <p>The Dot&apos;s agent started again while it was working, so the run it was in did not finish.</p>
            <Button type="button" variant="outline" size="xs" onClick={() => dismissRestart(dotId)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <ErrorBox error={dot.error} title="Could not refresh this Dot" />
    </header>
  );
}
