"use client";

import { ringState, type RingState } from "../../lib/attention";
import type { Dot } from "../../lib/types";
import { useDotAttention, useDotLive } from "../shell/attention";

/** The ring of a Dot's avatar, from its record, what the stream says it is doing, and the approvals that wait; the quiet grey one until the record is loaded. */
export function useDotRing(dotId: string, record: Dot | undefined): RingState {
  const { pendingApprovals } = useDotAttention(dotId);
  const live = useDotLive(dotId);
  if (record === undefined) return "stopped";
  return ringState({ status: record.status, computerState: record.computer_state, agentState: live.agent, pendingApprovals });
}
