/**
 * What the live stream says about each Dot that the stored records do not: the agent's newest state, whether it was
 * restarted in the middle of work, and whether it answered since the person last looked. Only what arrived since
 * this page opened is known; the stored Dot status (READY, RUNNING, ...) covers what came before.
 */
import type { AgentState, StoredEvent } from "@invisible-dots/shared/browser";

export interface LiveDot {
  agent: AgentState | null;
  /** The agent started again while it was working or waiting: the run it was in did not finish. */
  restarted: boolean;
  /** A reply arrived while another page was open. */
  unread: boolean;
}

export type LiveDots = Readonly<Record<string, LiveDot>>;

const BUSY: readonly AgentState[] = ["THINKING", "PLANNING", "EXECUTING", "WAITING_APPROVAL"];
const WORKING: readonly AgentState[] = ["THINKING", "PLANNING", "EXECUTING"];

const QUIET: LiveDot = { agent: null, restarted: false, unread: false };

export function liveOf(live: LiveDots, dotId: string): LiveDot {
  return live[dotId] ?? QUIET;
}

/** The Dot a path belongs to (`/dots/<id>/...`), or null on any other page. */
export function dotIdFromPath(pathname: string): string | null {
  const match = /^\/dots\/([^/]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

function with_(live: LiveDots, dotId: string, change: Partial<LiveDot>): LiveDots {
  const before = liveOf(live, dotId);
  const after = { ...before, ...change };
  if (after.agent === before.agent && after.restarted === before.restarted && after.unread === before.unread) return live;
  return { ...live, [dotId]: after };
}

/** Fold one live event in. `openDotId` is the Dot whose page is open, which cannot have unread replies. */
export function applyLiveEvent(live: LiveDots, event: StoredEvent, openDotId: string | null): LiveDots {
  const dotId = event.dot_id;
  if (!dotId) return live;
  switch (event.type) {
    case "agent.state": {
      const state = event.data.state as AgentState;
      return with_(live, dotId, { agent: state, restarted: WORKING.includes(state) ? false : liveOf(live, dotId).restarted });
    }
    case "agent.started": {
      const before = liveOf(live, dotId).agent;
      return with_(live, dotId, { agent: null, restarted: before !== null && BUSY.includes(before) ? true : liveOf(live, dotId).restarted });
    }
    case "message.assistant":
      return dotId === openDotId ? live : with_(live, dotId, { unread: true });
    case "dot.deleted": {
      if (!(dotId in live)) return live;
      const { [dotId]: _gone, ...rest } = live;
      return rest;
    }
    default:
      return live;
  }
}

export function markRead(live: LiveDots, dotId: string): LiveDots {
  return with_(live, dotId, { unread: false });
}

export function dismissRestart(live: LiveDots, dotId: string): LiveDots {
  return with_(live, dotId, { restarted: false });
}
