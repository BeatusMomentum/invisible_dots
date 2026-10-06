import { describe, expect, it } from "vitest";
import type { BrowserIdentity, DotConfig } from "../src/lib/types";
import { identityLimits, identityOrder, identityStatus, newIdentity } from "../src/lib/identity";

const identity = (id: string, name: string, status: BrowserIdentity["status"]): BrowserIdentity => ({ id, name, status, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, profilePath: `/home/dot/browsers/${id}`, hasProxy: false });

describe("how a browser's state is said", () => {
  it("calls a browser that is not running Closed, not available, and gives each state a tone", () => {
    expect(identityStatus("open")).toEqual({ label: "Open", tone: "ok" });
    expect(identityStatus("available")).toEqual({ label: "Closed", tone: "neutral" });
    expect(identityStatus("archived")).toEqual({ label: "Archived", tone: "neutral" });
  });
});

describe("the limits of a Dot's browsers", () => {
  it("are the config's, and the schema's defaults when the config says nothing", () => {
    expect(identityLimits({ browser: { identities: { managed_by_dot: false, max_identities: 5, max_open: 2 } } } as DotConfig)).toEqual({ managedByDot: false, maxIdentities: 5, maxOpen: 2 });
    expect(identityLimits(null)).toEqual({ managedByDot: true, maxIdentities: 20, maxOpen: 3 });
    expect(identityLimits({} as DotConfig)).toEqual({ managedByDot: true, maxIdentities: 20, maxOpen: 3 });
  });
});

describe("the order of the browsers", () => {
  it("puts the open ones first, then goes by name", () => {
    const list = [identity("c", "Charlie", "available"), identity("b", "bravo", "open"), identity("a", "Alpha", "available"), identity("z", "zulu", "open")];
    expect(identityOrder(list).map((i) => i.id)).toEqual(["b", "z", "a", "c"]);
    expect(list.map((i) => i.id)).toEqual(["c", "b", "a", "z"]);
  });
});

describe("a new browser", () => {
  const limits = { managedByDot: true, maxIdentities: 2, maxOpen: 1 };

  it("sends the trimmed name, and a proxy only when one was typed, as typed (the browser library judges it)", () => {
    expect(newIdentity("  shop  ", "", 0, limits)).toEqual({ ok: true, request: { name: "shop" } });
    expect(newIdentity("shop", "   ", 0, limits)).toEqual({ ok: true, request: { name: "shop" } });
    expect(newIdentity("shop", "socks5://proxy.example:1080", 0, limits)).toEqual({ ok: true, request: { name: "shop", proxy: "socks5://proxy.example:1080" } });
    expect(newIdentity("shop", "not a url", 0, limits)).toEqual({ ok: true, request: { name: "shop", proxy: "not a url" } });
  });

  it("refuses what the engine's rules refuse, in the engine's words", () => {
    expect(newIdentity("   ", "", 0, limits)).toEqual({ ok: false, problem: "an identity needs a non-empty name" });
    expect(newIdentity("x".repeat(81), "", 0, limits)).toMatchObject({ ok: false, problem: expect.stringContaining("at most 80") });
  });

  it("says when the Dot has all the browsers it may have", () => {
    expect(newIdentity("shop", "", 2, limits)).toMatchObject({ ok: false, problem: expect.stringContaining("max_identities 2") });
    expect(newIdentity("shop", "", 1, limits).ok).toBe(true);
  });
});
