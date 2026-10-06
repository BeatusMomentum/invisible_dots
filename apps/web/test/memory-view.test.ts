import { describe, expect, it } from "vitest";
import { MEMORY_VIEWS, memoryHref, parseMemoryQuery } from "../src/lib/memory-view";

describe("the address of the Memory page", () => {
  it("opens on the notes when it says nothing, or something that is not a view", () => {
    expect(parseMemoryQuery({})).toEqual({ view: "notes", note: null });
    expect(parseMemoryQuery({ view: "journal" })).toEqual({ view: "notes", note: null });
    expect(parseMemoryQuery({ view: "" })).toEqual({ view: "notes", note: null });
  });

  it("reads each view, and the first of a value given twice", () => {
    for (const view of MEMORY_VIEWS) expect(parseMemoryQuery({ view }).view).toBe(view);
    expect(parseMemoryQuery({ view: ["automations", "notes"] }).view).toBe("automations");
  });

  it("keeps the open note for the Notes view alone", () => {
    expect(parseMemoryQuery({ note: "trips/rome.md" })).toEqual({ view: "notes", note: "trips/rome.md" });
    expect(parseMemoryQuery({ view: "notes", note: "fares.md" })).toEqual({ view: "notes", note: "fares.md" });
    expect(parseMemoryQuery({ view: "automations", note: "fares.md" })).toEqual({ view: "automations", note: null });
  });

  it("writes the shortest address that says the same, with the Dot's name or id and the note encoded", () => {
    expect(memoryHref("d1")).toBe("/dots/d1/memory");
    expect(memoryHref("d1", { view: "notes" })).toBe("/dots/d1/memory");
    expect(memoryHref("d1", { view: "automations" })).toBe("/dots/d1/memory?view=automations");
    expect(memoryHref("my dot", { note: "a b.md" })).toBe("/dots/my%20dot/memory?note=a+b.md");
    expect(memoryHref("d1", { note: "trips/rome.md" })).toBe("/dots/d1/memory?note=trips%2Frome.md");
    // A note is not carried into the other view.
    expect(memoryHref("d1", { view: "automations", note: "fares.md" })).toBe("/dots/d1/memory?view=automations");
  });

  it("round-trips: what href writes, parse reads", () => {
    const href = memoryHref("d1", { note: "trips/rome & more.md" });
    const params = Object.fromEntries(new URL(href, "http://web.test").searchParams);
    expect(parseMemoryQuery(params)).toEqual({ view: "notes", note: "trips/rome & more.md" });
  });
});
