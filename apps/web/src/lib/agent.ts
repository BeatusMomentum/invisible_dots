import type { AgentState } from "@invisible-dots/shared/browser";

export type AgentStateValue = AgentState;

const LABELS: Record<AgentState, string> = {
  IDLE: "Idle",
  THINKING: "Thinking...",
  PLANNING: "Planning...",
  EXECUTING: "Running a tool...",
  WAITING_APPROVAL: "Waiting for an approval",
  DONE: "Done",
};

export function agentStateLabel(state: string): string {
  return (LABELS as Record<string, string>)[state] ?? state;
}
