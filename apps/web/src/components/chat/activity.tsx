"use client";

import { BrainIcon, ChevronRightIcon, ClockIcon, FileTextIcon, FilePenIcon, FingerprintIcon, GlobeIcon, HandIcon, MonitorIcon, TerminalIcon, WrenchIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ToolFamily } from "../../lib/events/tool-labels";
import { clusterSummary, groupActivity, type ActivityItem, type ApprovalStep, type MemoryChip, type ToolStep } from "../../lib/chat-thread";
import { formatDate, formatMillis } from "../../lib/format";
import { cn } from "../../lib/utils";
import { ActivityStep, type ActivityStepTone } from "./activity-step";
import { TOOL_STATUS, ToolStatusWord } from "./tool-status";

export const FAMILY_ICON: Record<ToolFamily, LucideIcon> = {
  command: TerminalIcon,
  read: FileTextIcon,
  write: FilePenIcon,
  memory: BrainIcon,
  automation: ClockIcon,
  screen: MonitorIcon,
  "browser-identity": FingerprintIcon,
  browser: GlobeIcon,
  other: WrenchIcon,
};

const STATE_TONE: Record<ToolStep["state"], ActivityStepTone> = { ok: "neutral", error: "error", denied: "warn", interrupted: "warn" };

/** One tool call as a quiet line: what it did, what it acted on, and how it ended when that was not well. */
export function ToolLine({ step }: { step: ToolStep }) {
  const status = TOOL_STATUS[step.state];
  const full = `${step.label}${step.target ? `: ${step.target}` : ""} (${status.word}${step.durationMs > 0 ? `, ${formatMillis(step.durationMs)}` : ""})`;
  return (
    <ActivityStep
      icon={FAMILY_ICON[step.family]}
      tone={STATE_TONE[step.state]}
      title={full}
      label={
        <>
          <span className="shrink-0">{step.label}</span>
          {step.target ? <code className="min-w-0 truncate font-mono text-xs font-normal text-muted-foreground/90">{step.target}</code> : null}
          <ToolStatusWord state={step.state} />
          {step.durationMs >= 1000 ? <span className="shrink-0 text-xs font-normal tabular-nums">{formatMillis(step.durationMs)}</span> : null}
        </>
      }
    />
  );
}

const APPROVAL_WORD: Record<ApprovalStep["outcome"], string> = { waiting: "Waiting for your answer", approved: "Allowed", rejected: "Denied" };

/**
 * An approval the Dot asked for in the conversation, in place. Until the inline approval card exists (step W6) the
 * waiting line links to the Dot's approvals, where the person answers; once answered it is a receipt.
 */
export function ApprovalLine({ dotId, step }: { dotId: string; step: ApprovalStep }) {
  const waiting = step.outcome === "waiting";
  return (
    <ActivityStep
      icon={HandIcon}
      tone={waiting ? "warn" : step.outcome === "approved" ? "success" : "error"}
      title={step.reason || undefined}
      label={
        <span className="min-w-0 whitespace-normal">
          <span className={cn(waiting && "text-warn")}>{APPROVAL_WORD[step.outcome]}:</span> {step.label.toLowerCase()}
          {step.reason ? <span className="font-normal"> ({step.reason})</span> : null}
          {waiting ? (
            <>
              {" "}
              <Link href={`/dots/${encodeURIComponent(dotId)}/approvals`} className="text-primary underline underline-offset-2">
                Answer it in Approvals
              </Link>
            </>
          ) : null}
        </span>
      }
    />
  );
}

/** A note the Dot saved to its memory. */
export function MemoryNote({ chip }: { chip: MemoryChip }) {
  return (
    <span title={`Saved to memory at ${formatDate(chip.at)}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground">
      <BrainIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="shrink-0">Remembered</span>
      <code className="min-w-0 truncate font-mono">{chip.key}</code>
    </span>
  );
}

/** A long run of tool calls, folded into one line that opens. */
function Cluster({ steps }: { steps: readonly ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const bad = steps.some((step) => step.state !== "ok");
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded py-0.5 text-ui font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className={cn(bad && "text-warn")}>{clusterSummary(steps)}</span>
      </button>
      {open ? (
        <ul aria-label="Steps" className="mt-0.5 ml-1.5 space-y-0 border-l pl-3">
          {steps.map((step) => (
            <li key={step.id}>
              <ToolLine step={step} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** What the Dot did between two messages: quiet lines, memory chips, and approvals in the place they were asked. */
export function Activity({ dotId, items }: { dotId: string; items: readonly ActivityItem[] }) {
  const groups = groupActivity(items);
  return (
    <ul aria-label="What the Dot did" className="space-y-0.5">
      {groups.map((group) => {
        if (group.kind === "cluster") return <Cluster key={`c${group.steps[0]!.id}`} steps={group.steps} />;
        const item = group.item;
        return (
          <li key={item.id}>
            {item.kind === "tool" ? <ToolLine step={item} /> : item.kind === "approval" ? <ApprovalLine dotId={dotId} step={item} /> : <MemoryNote chip={item} />}
          </li>
        );
      })}
    </ul>
  );
}
