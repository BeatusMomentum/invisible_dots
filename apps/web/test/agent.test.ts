import { describe, expect, it } from "vitest";
import { statePill } from "../src/lib/agent";

describe("the state pill of a Dot", () => {
  it("says what the agent is doing when this page has seen it", () => {
    expect(statePill("RUNNING", "THINKING")).toEqual({ label: "Thinking...", tone: "info", working: true });
    expect(statePill("RUNNING", "EXECUTING")).toMatchObject({ label: "Running a tool...", working: true });
    expect(statePill("READY", "PLANNING")).toMatchObject({ label: "Planning...", working: true });
    expect(statePill("RUNNING", "IDLE")).toEqual({ label: "Idle", tone: "neutral", working: false });
    expect(statePill("RUNNING", "DONE")).toMatchObject({ label: "Idle", working: false });
  });

  it("falls back to the stored status for what happened before the page opened", () => {
    expect(statePill("READY", null)).toMatchObject({ label: "Idle", working: false });
    expect(statePill("IDLE", null)).toMatchObject({ label: "Idle" });
    expect(statePill("RUNNING", null)).toEqual({ label: "Working on a task", tone: "info", working: true });
  });

  it("asks for the person whether the agent or the status says so", () => {
    expect(statePill("READY", "WAITING_APPROVAL")).toEqual({ label: "Waiting for you", tone: "warn", working: false });
    expect(statePill("WAITING_APPROVAL", null)).toMatchObject({ label: "Waiting for you", tone: "warn" });
  });

  it("lets an error, a disabled Dot and a Dot being created override the agent's last word", () => {
    expect(statePill("ERROR", "THINKING")).toEqual({ label: "Error", tone: "error", working: false });
    expect(statePill("DISABLED", "IDLE")).toMatchObject({ label: "Disabled", tone: "neutral" });
    expect(statePill("CREATING", null)).toMatchObject({ label: "Preparing the computer", working: true });
  });
});
