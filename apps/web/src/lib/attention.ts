/**
 * What needs the person, per Dot, and how that is drawn. One function owns it, and the rail badges, the
 * avatar ring, the document title and the favicon all read it, so they can never disagree.
 *
 * Two parts of the design's attention model have no data to read yet and are left out on purpose, not
 * stubbed: failed tasks of the last 24 hours (step W6, with the Inbox, which is their only place) and a
 * channel that needs relinking (step W12, with the channels API).
 */
import type { AgentState, DotState, VmState } from "@invisible-dots/shared/browser";

export interface DotAttention {
  /** Approvals of this Dot that wait for an answer. */
  pendingApprovals: number;
  /** Why the Dot is in ERROR; null when it is not. */
  error: string | null;
}

export const NO_ATTENTION: DotAttention = { pendingApprovals: 0, error: null };

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

/** Per Dot id; a Dot with nothing waiting is in the map with NO_ATTENTION. */
export function attentionByDot(dots: readonly AttentionDot[], approvals: readonly AttentionApproval[]): Map<string, DotAttention> {
  const byDot = new Map<string, DotAttention>();
  for (const dot of dots) {
    byDot.set(dot.id, { pendingApprovals: 0, error: dot.status === "ERROR" ? (dot.error ?? "The Dot is in an error state") : null });
  }
  for (const approval of approvals) {
    const entry = byDot.get(approval.dot_id);
    if (entry && approval.status === "pending") entry.pendingApprovals++;
  }
  return byDot;
}

/** Approvals waiting across every Dot: the number on the rail's Approvals entry. */
export function pendingApprovalCount(attention: ReadonlyMap<string, DotAttention>): number {
  let total = 0;
  for (const entry of attention.values()) total += entry.pendingApprovals;
  return total;
}

/** Things that need the person: waiting approvals plus Dots in ERROR. Drives the title prefix and the favicon. */
export function needsYouCount(attention: ReadonlyMap<string, DotAttention>): number {
  let total = 0;
  for (const entry of attention.values()) total += entry.pendingApprovals + (entry.error === null ? 0 : 1);
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
  if (input.computerState === "RUNNING" || input.computerState === "IDLE") return "ready";
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
