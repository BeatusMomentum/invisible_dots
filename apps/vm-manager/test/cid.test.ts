import { describe, expect, it } from "vitest";
import { allocateCid, cidBaseFromEnv, isCidInUseError } from "../src/index.js";

describe("CID allocation", () => {
  it("starts at the base", () => {
    expect(allocateCid([], 10000)).toBe(10000);
  });

  it("skips taken CIDs and fills gaps", () => {
    expect(allocateCid([10000, 10001, 10003], 10000)).toBe(10002);
  });

  it("never goes below the reserved CIDs", () => {
    expect(allocateCid([], 0)).toBe(3);
  });

  it("reads INVISIBLE_DOTS_CID_BASE", () => {
    expect(cidBaseFromEnv({})).toBe(10000);
    expect(cidBaseFromEnv({ INVISIBLE_DOTS_CID_BASE: "20000" })).toBe(20000);
    expect(() => cidBaseFromEnv({ INVISIBLE_DOTS_CID_BASE: "2" })).toThrow(/not a valid vsock CID/);
    expect(() => cidBaseFromEnv({ INVISIBLE_DOTS_CID_BASE: "abc" })).toThrow(/INVISIBLE_DOTS_CID_BASE/);
  });

  it("recognises the kernel's in-use answer", () => {
    expect(
      isCidInUseError("error: Failed to start domain 'x'\nerror: internal error: unable to set guest cid: Address already in use"),
    ).toBe(true);
    expect(isCidInUseError("error: Cannot access storage file")).toBe(false);
  });
});
