import { HOST_EVENT_TYPES, INBOUND_EVENT_TYPES, OUTBOUND_EVENT_TYPES } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { Backoff, hashPairingCode, newPairingCode, normalizePairingCode, PAIRING_CODE_LENGTH, splitText } from "../src/index.js";
import { RateLimiter } from "../src/rate.js";

describe("the guest protocol", () => {
  it("names no channel: the Dot never sees one", () => {
    for (const type of [...INBOUND_EVENT_TYPES, ...OUTBOUND_EVENT_TYPES]) expect(type).not.toMatch(/channel|telegram|whatsapp/);
    expect(HOST_EVENT_TYPES.filter((t) => t.startsWith("channel."))).toEqual(["channel.status", "channel.peer.paired"]);
  });
});

describe("splitText", () => {
  it("leaves short text alone and drops only the whitespace at the ends", () => {
    expect(splitText("hello", 10)).toEqual(["hello"]);
    expect(splitText("  hello \n", 10)).toEqual(["hello"]);
    expect(splitText("", 10)).toEqual([]);
  });

  it("cuts at a blank line, then a line break, then a space, before the limit", () => {
    expect(splitText("first paragraph\n\nsecond paragraph", 20)).toEqual(["first paragraph", "second paragraph"]);
    expect(splitText("line one\nline two\nline three", 18)).toEqual(["line one\nline two", "line three"]);
    expect(splitText("alpha beta gamma delta", 12)).toEqual(["alpha beta", "gamma delta"]);
  });

  it("cuts a word longer than the limit, and keeps every piece within it", () => {
    expect(splitText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    const long = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const pieces = splitText(long, 100);
    expect(pieces.every((p) => p.length <= 100)).toBe(true);
    expect(pieces.join(" ")).toBe(long);
  });

  it("never leaves half of an emoji at the end of a piece", () => {
    const pieces = splitText("😀😀😀😀😀😀", 5);
    expect(pieces.join("")).toBe("😀😀😀😀😀😀");
    for (const piece of pieces) expect([...piece].every((c) => c.codePointAt(0)! >= 0x1f600)).toBe(true);
  });

  it("refuses a limit that is not a positive integer", () => {
    expect(() => splitText("x", 0)).toThrow(RangeError);
    expect(() => splitText("x", 1.5)).toThrow(RangeError);
  });
});

describe("Backoff", () => {
  it("doubles up to the maximum, never exceeds it, and starts over after a reset", () => {
    const backoff = new Backoff({ initialMs: 100, maxMs: 1_000, jitter: 0 });
    expect([1, 2, 3, 4, 5, 6].map(() => backoff.next())).toEqual([100, 200, 400, 800, 1_000, 1_000]);
    backoff.reset();
    expect(backoff.next()).toBe(100);
  });

  it("jitter only shortens the wait", () => {
    const low = new Backoff({ initialMs: 1_000, maxMs: 1_000, jitter: 0.5 }, () => 1);
    const none = new Backoff({ initialMs: 1_000, maxMs: 1_000, jitter: 0.5 }, () => 0);
    expect(low.next()).toBe(500);
    expect(none.next()).toBe(1_000);
  });
});

describe("pairing codes", () => {
  it("are eight symbols without the ones that read alike, and differ", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newPairingCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(new RegExp(`^[A-HJ-NP-Z2-9]{${PAIRING_CODE_LENGTH}}$`));
  });

  it("are read back whatever the case or the spaces, and hash per binding", () => {
    expect(normalizePairingCode("  ab3d \n")).toBe("AB3D");
    expect(hashPairingCode("chb_1", "ab3d")).toBe(hashPairingCode("chb_1", " AB3D "));
    expect(hashPairingCode("chb_1", "AB3D")).not.toBe(hashPairingCode("chb_2", "AB3D"));
    expect(hashPairingCode("chb_1", "AB3D")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("RateLimiter", () => {
  it("allows the burst, refuses the next, and refills with time, per key", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1, { now: () => new Date(now) });
    expect([1, 2, 3, 4].map(() => limiter.take("a"))).toEqual([true, true, true, false]);
    expect(limiter.take("b")).toBe(true);
    now += 1_000;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    now += 60_000;
    expect([1, 2, 3, 4].map(() => limiter.take("a"))).toEqual([true, true, true, false]);
  });
});
