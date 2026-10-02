import { describe, expect, it } from "vitest";
import { AGENT_STATES, DOT_STATES, isAgentState, isTaskState, TASK_STATES, VM_STATES } from "../src/index.js";

describe("state lists", () => {
  it("match sections 8.1 and 9.3", () => {
    expect(AGENT_STATES).toEqual(["IDLE", "THINKING", "PLANNING", "EXECUTING", "WAITING_APPROVAL", "DONE"]);
    expect(VM_STATES).toEqual(["PROVISIONING", "STARTING", "RUNNING", "IDLE", "STOPPING", "STOPPED", "ERROR", "DELETING"]);
    expect(DOT_STATES).toEqual(["CREATING", "READY", "IDLE", "RUNNING", "WAITING_APPROVAL", "ERROR", "DISABLED"]);
    expect(TASK_STATES).toEqual(["PENDING", "RUNNING", "WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"]);
    expect(isAgentState("THINKING")).toBe(true);
    expect(isAgentState("thinking")).toBe(false);
    expect(isTaskState("PENDING")).toBe(true);
  });
});
