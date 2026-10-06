import type { ChannelLinkFrame } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { IDLE, linkEnded, reduceLink, STREAM_LOST, type LinkAction, type LinkView } from "../src/lib/channel-link";

function run(actions: LinkAction[], from: LinkView = IDLE): LinkView {
  return actions.reduce(reduceLink, from);
}

const frame = (f: ChannelLinkFrame): LinkAction => ({ type: "frame", frame: f });

describe("linking WhatsApp as the host's frames tell it", () => {
  it("starts, waits for the first code, shows each code as it is replaced, and ends linked", () => {
    expect(run([{ type: "start" }])).toEqual({ phase: "starting" });
    expect(run([{ type: "start" }, frame({ state: "waiting" })])).toEqual({ phase: "waiting", detail: null });
    expect(run([{ type: "start" }, frame({ state: "waiting", detail: "retrying" })])).toEqual({ phase: "waiting", detail: "retrying" });
    expect(run([{ type: "start" }, frame({ state: "waiting" }), frame({ state: "code", code: "one" })])).toEqual({ phase: "scan", code: "one" });
    expect(run([{ type: "start" }, frame({ state: "code", code: "one" }), frame({ state: "code", code: "two" })])).toEqual({ phase: "scan", code: "two" });
    expect(run([{ type: "start" }, frame({ state: "code", code: "one" }), frame({ state: "linked", account: "15550001111" })])).toEqual({ phase: "linked", account: "15550001111" });
  });

  it("shows a connection that restarts after a scan as waiting again, then the next code", () => {
    const view = run([{ type: "start" }, frame({ state: "code", code: "one" }), frame({ state: "waiting" })]);
    expect(view).toEqual({ phase: "waiting", detail: null });
    expect(reduceLink(view, frame({ state: "code", code: "two" }))).toEqual({ phase: "scan", code: "two" });
  });

  it("ends failed with the host's reason, and keeps the last frame whatever comes after it", () => {
    const failed = run([{ type: "start" }, frame({ state: "code", code: "one" }), frame({ state: "failed", detail: "The code expired." })]);
    expect(failed).toEqual({ phase: "failed", detail: "The code expired." });
    expect(reduceLink(failed, frame({ state: "code", code: "late" }))).toBe(failed);
    expect(reduceLink(failed, { type: "error", message: STREAM_LOST })).toBe(failed);
    const linked = run([frame({ state: "linked", account: null })]);
    expect(reduceLink(linked, frame({ state: "failed", detail: "late" }))).toBe(linked);
  });

  it("begins again from a last frame only with a new start", () => {
    const failed: LinkView = { phase: "failed", detail: "x" };
    expect(reduceLink(failed, { type: "start" })).toEqual({ phase: "starting" });
    expect(reduceLink(failed, { type: "reset" })).toEqual(IDLE);
  });

  it("says a stream that dropped or a request that failed as a failure, while the link is still going on", () => {
    expect(run([{ type: "start" }, { type: "error", message: STREAM_LOST }])).toEqual({ phase: "failed", detail: STREAM_LOST });
    expect(run([{ type: "start" }, frame({ state: "code", code: "one" }), { type: "error", message: "502" }])).toEqual({ phase: "failed", detail: "502" });
  });

  it("knows when the link is over", () => {
    expect(linkEnded({ phase: "linked", account: null })).toBe(true);
    expect(linkEnded({ phase: "failed", detail: "x" })).toBe(true);
    for (const view of [IDLE, { phase: "starting" }, { phase: "waiting", detail: null }, { phase: "scan", code: "c" }] as LinkView[]) expect(linkEnded(view)).toBe(false);
  });
});
