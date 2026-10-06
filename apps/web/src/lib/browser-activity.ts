/**
 * What the Dot is doing with its browsers, read from its event log: which identity a call names, which page it was
 * last sent to, and whether it is using one right now. The log is the one record of it: the identity routes know
 * only a state (open, available), and the engine does not say which page a window shows.
 *
 * A browser tool's `tool.called` carries a redacted `target` the engine builds (nanobot/dots/targets.py): the
 * identity's id alone, or `<identity id>: <detail>`, where the detail of `browser_navigate` is the URL as a command's
 * URLs are shown (no user or password, query values masked). `browser_identity_create` names the identity it made,
 * not an id, and `browser_identity_list` names nothing, so neither says anything about an identity here.
 */
import { toolLabel } from "./events/tool-labels";
import { mergeEvents } from "./timeline";
import type { StoredEvent } from "./types";

/** A call is "now" for this long after it was logged: a call is logged when it ends, and the next of a turn follows within seconds. */
export const USING_NOW_SECONDS = 20;

/** The event types that tell what the browsers do: the calls, and the two events after which an identity shows no page of ours. */
export const BROWSER_ACTIVITY_EVENT_TYPES: readonly string[] = ["tool.called", "browser.identity.launched", "browser.identity.closed"];

/** The tools whose target starts with the id of the identity they act on. */
function actsOnIdentity(tool: string): boolean {
  if (tool === "browser_identity_create" || tool === "browser_identity_list") return false;
  const { family } = toolLabel(tool);
  return family === "browser" || family === "browser-identity";
}

export interface BrowserCall {
  identityId: string;
  tool: string;
  /** What the call acted on after the id (the URL of a navigation), or null. */
  detail: string | null;
  /** ISO 8601 time the call was logged. */
  at: string;
  /** The call ran and succeeded: not refused, not failed, not cut by a stop. */
  succeeded: boolean;
}

/** The call a `tool.called` event reports when it is one that acts on a browser identity, else null. */
export function browserCall(event: StoredEvent): BrowserCall | null {
  if (event.type !== "tool.called") return null;
  const data = event.data as { tool?: unknown; target?: unknown; ok?: unknown; decision?: unknown; interrupted?: unknown };
  if (typeof data.tool !== "string" || !actsOnIdentity(data.tool) || typeof data.target !== "string" || data.target === "") return null;
  const split = data.target.indexOf(": ");
  const identityId = split < 0 ? data.target : data.target.slice(0, split);
  const detail = split < 0 ? null : data.target.slice(split + 2);
  return { identityId, tool: data.tool, detail: detail === "" ? null : detail, at: event.created_at, succeeded: data.ok === true && data.interrupted !== true };
}

/** Whether an event is one the browsers' activity is read from. */
export function isBrowserActivityEvent(event: StoredEvent): boolean {
  if (event.type === "tool.called") return browserCall(event) !== null;
  return event.type === "browser.identity.launched" || event.type === "browser.identity.closed";
}

export function mergeBrowserEvents(current: readonly StoredEvent[], incoming: readonly StoredEvent[]): StoredEvent[] {
  return mergeEvents(current, incoming.filter(isBrowserActivityEvent));
}

export interface IdentityActivity {
  /** The page the Dot last sent this browser to, as shown; null when it has sent it none since it opened. */
  page: string | null;
  /** The Dot called a tool on this browser within USING_NOW_SECONDS. */
  usingNow: boolean;
  /** ISO 8601 time of its newest call; null when the log holds none. */
  lastCallAt: string | null;
}

/** What the log says of one identity, `events` being oldest first and `now` in milliseconds. */
export function identityActivity(events: readonly StoredEvent[], identityId: string, now: number): IdentityActivity {
  let page: string | null = null;
  let pageSettled = false;
  let lastCallAt: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "browser.identity.launched" || event.type === "browser.identity.closed") {
      // A window that was just opened, or ended, shows no page the Dot chose.
      if (event.data.identity_id === identityId) pageSettled = true;
      continue;
    }
    const call = browserCall(event);
    if (call === null || call.identityId !== identityId) continue;
    lastCallAt ??= call.at;
    if (!pageSettled && call.tool === "browser_navigate" && call.succeeded && call.detail !== null) {
      page = call.detail;
      pageSettled = true;
    }
    if (pageSettled && lastCallAt !== null) break;
  }
  const at = lastCallAt === null ? NaN : Date.parse(lastCallAt);
  // The host's clock and this page's may differ by a little: a call a few seconds ahead of the page is as current as one behind it.
  return { page, usingNow: !Number.isNaN(at) && Math.abs(now - at) <= USING_NOW_SECONDS * 1000, lastCallAt };
}
