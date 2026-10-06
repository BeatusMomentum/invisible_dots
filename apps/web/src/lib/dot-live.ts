/**
 * What the live stream says about each Dot that the stored records do not: the agent's newest state, whether it was
 * restarted in the middle of work, whether it answered since the person last looked, and what its running task last
 * reported. What arrived since this page opened is known, and for the Dot whose page is open the newest agent event the
 * log holds is read once and applied like a live one (an event older than what is known does not undo it); the
 * stored Dot status (READY, RUNNING, ...) covers the rest. A computer that
 * is not running has no agent: the state of the agent ends with it.
 */
import type { AgentState, StoredEvent } from "@invisible-dots/shared/browser";

export interface LiveDot {
  agent: AgentState | null;
  /** The id of the newest event that set or ended `agent`: an older one (a replay, a read of the log) does not undo it. */
  agentAt: number;
  /** The agent started again while it was working or waiting: the run it was in did not finish. */
  restarted: boolean;
  /** A reply arrived while another page was open. */
  unread: boolean;
  /** The newest thing a running task reported, until that task ends. */
  progress: LiveProgress | null;
}

export interface LiveProgress {
  taskId: string;
  text: string;
}

export type LiveDots = Readonly<Record<string, LiveDot>>;

const BUSY: readonly AgentState[] = ["THINKING", "PLANNING", "EXECUTING", "WAITING_APPROVAL"];
const WORKING: readonly AgentState[] = ["THINKING", "PLANNING", "EXECUTING"];

const QUIET: LiveDot = { agent: null, agentAt: 0, restarted: false, unread: false, progress: null };

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

/** The computer went off or is going: the agent it ran is gone, and so is what its task last reported. */
function computerOff(live: LiveDots, event: StoredEvent): LiveDots {
  const before = liveOf(live, event.dot_id);
  if (event.id <= before.agentAt && before.agent === null && before.progress === null) return live;
  return with_(live, event.dot_id, { agent: null, agentAt: Math.max(before.agentAt, event.id), progress: null });
}

function with_(live: LiveDots, dotId: string, change: Partial<LiveDot>): LiveDots {
  const before = liveOf(live, dotId);
  const after = { ...before, ...change };
  if (after.agent === before.agent && after.restarted === before.restarted && after.unread === before.unread && after.progress === before.progress) return live;
  return { ...live, [dotId]: after };
}

/** Fold one live event in. `openDotId` is the Dot whose page is open, which cannot have unread replies. */
export function applyLiveEvent(live: LiveDots, event: StoredEvent, openDotId: string | null): LiveDots {
  const dotId = event.dot_id;
  if (!dotId) return live;
  switch (event.type) {
    case "agent.state": {
      if (event.id <= liveOf(live, dotId).agentAt) return live;
      const state = event.data.state as AgentState;
      return with_(live, dotId, { agent: state, agentAt: event.id, restarted: WORKING.includes(state) ? false : liveOf(live, dotId).restarted });
    }
    case "agent.started": {
      if (event.id <= liveOf(live, dotId).agentAt) return live;
      const before = liveOf(live, dotId).agent;
      // The run a task was in is gone with the process, so what it last reported is no longer news.
      return with_(live, dotId, { agent: null, agentAt: event.id, progress: null, restarted: before !== null && BUSY.includes(before) ? true : liveOf(live, dotId).restarted });
    }
    case "computer.stopped":
      return computerOff(live, event);
    case "computer.state":
      // Only a computer that runs has an agent: any other state (stopping, off, starting again, in error) ends what was known of it.
      return event.data.state === "RUNNING" ? live : computerOff(live, event);
    case "task.progress": {
      const { task_id, text } = event.data as { task_id?: unknown; text?: unknown };
      if (typeof task_id !== "string" || typeof text !== "string") return live;
      return with_(live, dotId, { progress: { taskId: task_id, text } });
    }
    case "task.completed":
    case "task.failed":
    case "task.cancelled": {
      const progress = liveOf(live, dotId).progress;
      return progress !== null && progress.taskId === event.data.task_id ? with_(live, dotId, { progress: null }) : live;
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
