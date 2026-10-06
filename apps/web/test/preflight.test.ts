import { describe, expect, it } from "vitest";
import { preflightItems } from "../src/lib/preflight";

const HEALTHY = { status: "ok", database: "ok", version: "1.2.3", openrouter_configured: true } as const;

describe("preflightItems", () => {
  it("is all ok when the control plane answers and holds a key", () => {
    const items = preflightItems({ health: HEALTHY });
    expect(items.map((item) => [item.id, item.state])).toEqual([["api", "ok"], ["database", "ok"], ["key", "ok"]]);
    expect(items[0]!.detail).toContain("1.2.3");
  });

  it("fails the key item, and only it, when no key is stored", () => {
    const items = preflightItems({ health: { ...HEALTHY, openrouter_configured: false } });
    expect(items.map((item) => item.state)).toEqual(["ok", "ok", "failed"]);
    expect(items[2]!.detail).toMatch(/cannot answer until one is/);
  });

  it("fails the control plane with the reason, and says the rest was not checked, when it does not answer", () => {
    const items = preflightItems({ error: "cannot reach the API" });
    expect(items.map((item) => item.state)).toEqual(["failed", "unknown", "unknown"]);
    expect(items[0]!.detail).toBe("cannot reach the API");
  });
});
