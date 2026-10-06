/**
 * What the person sees while they link WhatsApp, as a pure state machine over the host's frames: start, wait for the
 * first code, scan (the code is replaced every few seconds), then linked or failed. The host's stream
 * (`ChannelLinkFrame`) is the one source of truth; this reduces it to one view, and a connection that drops
 * before the last frame is its own failure, never a silent stop.
 */
import type { ChannelLinkFrame } from "@invisible-dots/shared/browser";

export type LinkView =
  | { phase: "idle" }
  /** The host was asked to start linking; nothing has come back yet. */
  | { phase: "starting" }
  /** The channel is starting and has no code yet; `detail` says why a connection is retried. */
  | { phase: "waiting"; detail: string | null }
  /** A code to scan. */
  | { phase: "scan"; code: string }
  | { phase: "linked"; account: string | null }
  | { phase: "failed"; detail: string };

export type LinkAction = { type: "start" } | { type: "frame"; frame: ChannelLinkFrame } | { type: "error"; message: string } | { type: "reset" };

export const IDLE: LinkView = { phase: "idle" };

/** Shown when the stream ends without a last frame: the server went away, or the page lost it. */
export const STREAM_LOST = "The connection to the server was lost before the link finished.";

/** Whether the link is over, one way or the other: the stream has nothing more to say. */
export function linkEnded(view: LinkView): boolean {
  return view.phase === "linked" || view.phase === "failed";
}

export function reduceLink(view: LinkView, action: LinkAction): LinkView {
  switch (action.type) {
    case "start":
      return { phase: "starting" };
    case "reset":
      return IDLE;
    case "error":
      return linkEnded(view) ? view : { phase: "failed", detail: action.message };
    case "frame": {
      // Nothing follows a last frame, whatever a late one says: only a new start begins again.
      if (linkEnded(view)) return view;
      const { frame } = action;
      switch (frame.state) {
        case "waiting":
          return { phase: "waiting", detail: frame.detail ?? null };
        case "code":
          return { phase: "scan", code: frame.code };
        case "linked":
          return { phase: "linked", account: frame.account };
        case "failed":
          return { phase: "failed", detail: frame.detail };
      }
    }
  }
}
