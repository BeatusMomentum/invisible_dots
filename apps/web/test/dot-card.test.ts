import { describe, expect, it } from "vitest";
import { cardStatus, filterDots, showSearch } from "../src/lib/dot-card";
import { dotRecord } from "./support/control-plane";

describe("showSearch", () => {
  it("appears with the seventh Dot and not before", () => {
    expect(showSearch(6)).toBe(false);
    expect(showSearch(7)).toBe(true);
  });
});

describe("filterDots", () => {
  const dots = [
    dotRecord("1", { name: "fare-watch", config: { goal: "Watch the fares from Milan to Lisbon", model: { provider: "openrouter", id: "z-ai/glm" } } as never }),
    dotRecord("2", { name: "inbox", config: { goal: "Sort the mail", model: { provider: "openrouter", id: "a/claude" } } as never }),
  ];

  it("keeps every Dot for an empty or blank query", () => {
    expect(filterDots(dots, "")).toHaveLength(2);
    expect(filterDots(dots, "   ")).toHaveLength(2);
  });

  it("matches the name, the goal and the model, ignoring case", () => {
    expect(filterDots(dots, "FARE").map((d) => d.id)).toEqual(["1"]);
    expect(filterDots(dots, "mail").map((d) => d.id)).toEqual(["2"]);
    expect(filterDots(dots, "claude").map((d) => d.id)).toEqual(["2"]);
  });

  it("needs every word, in any order", () => {
    expect(filterDots(dots, "lisbon fares").map((d) => d.id)).toEqual(["1"]);
    expect(filterDots(dots, "lisbon mail")).toEqual([]);
  });

  it("copes with a Dot whose config is missing", () => {
    expect(filterDots([dotRecord("3", { config: undefined as never })], "x")).toEqual([]);
  });
});

describe("cardStatus", () => {
  it("gives the reason beside an error, and the recorded text as it is", () => {
    expect(cardStatus({ status: "ERROR", error: "the guest never became healthy" }, null)).toMatchObject({ label: "Error", tone: "error", reason: "the guest never became healthy" });
  });

  it("says when an error has no recorded reason", () => {
    expect(cardStatus({ status: "ERROR", error: null }, null).reason).toBe("No reason was recorded.");
  });

  it("has no reason for a Dot that is not in error, and follows the live agent state", () => {
    expect(cardStatus({ status: "READY", error: null }, null)).toMatchObject({ label: "Idle", reason: null });
    expect(cardStatus({ status: "READY", error: null }, "THINKING")).toMatchObject({ label: "Thinking...", working: true, reason: null });
  });
});
