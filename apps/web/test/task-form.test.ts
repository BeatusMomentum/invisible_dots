import { describe, expect, it } from "vitest";
import { EMPTY_TASK_FORM, localInputToIso, parsePriority, taskFormProblem, taskRequest } from "../src/lib/task-form";

describe("localInputToIso", () => {
  it("turns local wall time into an instant, and nothing into nothing", () => {
    expect(localInputToIso("")).toBeUndefined();
    expect(localInputToIso("not a date")).toBeUndefined();
    expect(localInputToIso("2026-03-10T09:30")).toBe(new Date(2026, 2, 10, 9, 30).toISOString());
  });
});

describe("parsePriority", () => {
  it("takes whole numbers, signed, and refuses everything else", () => {
    expect(parsePriority("10")).toBe(10);
    expect(parsePriority(" -10 ")).toBe(-10);
    expect(parsePriority("0")).toBe(0);
    for (const bad of ["", "1.5", "high", "1e3", "--1", "12345678901"]) expect(parsePriority(bad)).toBeNull();
  });
});

describe("the New task form", () => {
  it("cannot be sent without a description, or with a priority that is no number, or a date that is none", () => {
    expect(taskFormProblem(EMPTY_TASK_FORM)).toMatch(/what the Dot should do/);
    expect(taskFormProblem({ ...EMPTY_TASK_FORM, description: "  " })).toMatch(/what the Dot should do/);
    expect(taskFormProblem({ ...EMPTY_TASK_FORM, description: "x", priority: "soon" })).toMatch(/whole number/);
    expect(taskFormProblem({ ...EMPTY_TASK_FORM, description: "x", notBefore: "tomorrow" })).toMatch(/date and time/);
    expect(taskFormProblem({ ...EMPTY_TASK_FORM, description: "x" })).toBeNull();
  });

  it("asks for the description alone when the rest is as the API has it by default", () => {
    expect(taskRequest({ description: "  Write the report ", priority: "0", notBefore: "" })).toEqual({ description: "Write the report" });
  });

  it("sends a priority that is not normal and a time that is set", () => {
    expect(taskRequest({ description: "x", priority: "10", notBefore: "2026-03-10T09:30" })).toEqual({
      description: "x",
      priority: 10,
      scheduled_at: new Date(2026, 2, 10, 9, 30).toISOString(),
    });
    expect(taskRequest({ description: "x", priority: "-10", notBefore: "" })).toEqual({ description: "x", priority: -10 });
  });
});
