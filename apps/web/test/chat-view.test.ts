import { describe, expect, it } from "vitest";
import { composerState, suggestions } from "../src/lib/chat-view";

describe("what the composer says", () => {
  it("lets the person write to a Dot whose computer is up, and says nothing", () => {
    expect(composerState({ status: "READY", computer_state: "RUNNING" })).toEqual({ blocked: null, hint: null });
    expect(composerState(undefined)).toEqual({ blocked: null, hint: null });
  });

  it("stops the person only for a Dot that is disabled or being deleted, and says why", () => {
    expect(composerState({ status: "DISABLED", computer_state: "STOPPED" }).blocked).toMatch(/disabled/);
    expect(composerState({ status: "READY", computer_state: "DELETING" }).blocked).toMatch(/being deleted/);
    // Being deleted wins over any other state.
    expect(composerState({ status: "DISABLED", computer_state: "DELETING" }).blocked).toMatch(/being deleted/);
  });

  it("explains the wait, without blocking, when the computer is not up", () => {
    for (const state of ["PROVISIONING", "STARTING", "STOPPED", "STOPPING"] as const) {
      const composer = composerState({ status: "READY", computer_state: state });
      expect(composer.blocked, state).toBeNull();
      expect(composer.hint, state).toMatch(/message/i);
    }
    expect(composerState({ status: "CREATING", computer_state: null }).blocked).toBeNull();
  });
});

describe("the first messages offered", () => {
  it("are three, the last drawn from the goal", () => {
    const offered = suggestions("Watch the airline fares to Lisbon and tell me when one drops");
    expect(offered).toHaveLength(3);
    expect(offered[2]).toBe("Start on your goal: Watch the airline fares to Lisbon and tell me when one drops");
  });

  it("cut a long goal to one line, whatever its whitespace", () => {
    const offered = suggestions(`${"word ".repeat(60)}\n\nend`);
    expect(offered[2]!.length).toBeLessThanOrEqual("Start on your goal: ".length + 90);
    expect(offered[2]).toMatch(/\.\.\.$/);
    expect(offered[2]).not.toMatch(/\n/);
  });

  it("do not pretend to have a goal when there is none", () => {
    expect(suggestions(undefined)[2]).toBe("What do you need from me to get started?");
    expect(suggestions("   ")[2]).toBe("What do you need from me to get started?");
  });
});
