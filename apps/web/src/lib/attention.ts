/**
 * What needs the person, per Dot, and how that is drawn. One function owns it, and the rail badges, the
 * avatar ring, the document title and the favicon all read it, so they can never disagree.
 *
 * One part of the design's attention model has no data to read yet and is left out on purpose, not stubbed: a
 * channel that needs relinking (step W12, with the channels API).
 */
import { computerIsUp, type AgentState, type DotState, type VmState } from "@invisible-dots/shared/browser";

export interface DotAttention {
  /** Approvals of this Dot that wait for an answer. */
  pendingApprovals: number;
  /** Why the Dot is in ERROR; null when it is not. */
  error: string | null;
  /** Tasks of this Dot that failed in the last 24 hours and that the person has not dismissed. */
  failedTasks: number;
}

export const NO_ATTENTION: DotAttention = { pendingApprovals: 0, error: null, failedTasks: 0 };

/** The parts of a Dot record the model reads. */
export interface AttentionDot {
  id: string;
  status: DotState;
  error: string | null;
}

/** The parts of an approval record the model reads. */
export interface AttentionApproval {
  dot_id: string;
  status: string;
}

/** The part of a failed task the model reads. */
export interface AttentionTask {
  dot_id: string;
}

/** Per Dot id; a Dot with nothing waiting is in the map with NO_ATTENTION. */
export function attentionByDot(dots: readonly AttentionDot[], approvals: readonly AttentionApproval[], failedTasks: readonly AttentionTask[] = []): Map<string, DotAttention> {
  const byDot = new Map<string, DotAttention>();
  for (const dot of dots) {
    byDot.set(dot.id, { pendingApprovals: 0, error: dot.status === "ERROR" ? (dot.error ?? "The Dot is in an error state") : null, failedTasks: 0 });
  }
  for (const approval of approvals) {
    const entry = byDot.get(approval.dot_id);
    if (entry && approval.status === "pending") entry.pendingApprovals++;
  }
  for (const task of failedTasks) {
    const entry = byDot.get(task.dot_id);
    if (entry) entry.failedTasks++;
  }
  return byDot;
}

/**
 * Things that need the person: waiting approvals, Dots in ERROR and tasks that failed lately. It is the number on the
 * rail's Inbox entry, in the title prefix and on the favicon, and the Inbox lists exactly that many things.
 */
export function needsYouCount(attention: ReadonlyMap<string, DotAttention>): number {
  let total = 0;
  for (const entry of attention.values()) total += entry.pendingApprovals + entry.failedTasks + (entry.error === null ? 0 : 1);
  return total;
}

/** "(3) " in front of the page title, nothing when nothing needs the person. */
export function titlePrefix(count: number): string {
  return count > 0 ? `(${count > 99 ? "99+" : count}) ` : "";
}

/** `title` with its attention prefix replaced by the one for `count`. */
export function withTitlePrefix(title: string, count: number): string {
  return titlePrefix(count) + title.replace(/^\(\d+\+?\) /, "");
}

/** The ring around a Dot's avatar. */
export type RingState = "stopped" | "ready" | "working" | "waiting" | "error";

export interface RingInput {
  status: DotState;
  computerState: VmState | null;
  /** The newest agent state seen live; null when none arrived since the page opened. */
  agentState: AgentState | null;
  pendingApprovals: number;
}

const WORKING_AGENT: readonly AgentState[] = ["THINKING", "PLANNING", "EXECUTING"];
const CHANGING_COMPUTER: readonly VmState[] = ["PROVISIONING", "STARTING", "STOPPING"];

/**
 * Error beats everything, a waiting approval beats work, and work (the agent thinking or running a tool, or the
 * computer changing state) beats a quiet running computer. A stopped or missing computer is grey.
 */
export function ringState(input: RingInput): RingState {
  if (input.status === "ERROR" || input.computerState === "ERROR") return "error";
  if (input.pendingApprovals > 0 || input.status === "WAITING_APPROVAL" || input.agentState === "WAITING_APPROVAL") return "waiting";
  if (input.status === "CREATING" || (input.agentState !== null && WORKING_AGENT.includes(input.agentState))) return "working";
  if (input.computerState !== null && CHANGING_COMPUTER.includes(input.computerState)) return "working";
  if (computerIsUp(input.computerState)) return "ready";
  return "stopped";
}

/** The ring said in words, for the people who cannot see the color. */
export const RING_LABEL: Record<RingState, string> = {
  stopped: "Computer stopped",
  ready: "Ready",
  working: "Working",
  waiting: "Waiting for you",
  error: "Needs attention: error",
};
