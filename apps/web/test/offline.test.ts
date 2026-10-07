import { describe, expect, it } from "vitest";
import { offlineOf } from "../src/lib/offline";

describe("when the page can no longer hear the control plane", () => {
  it("says nothing while the stream is up or starting and the health check answers", () => {
    expect(offlineOf({ stream: "open", streamDetail: "", apiError: null })).toBeNull();
    expect(offlineOf({ stream: "connecting", streamDetail: "", apiError: null })).toBeNull();
  });

  it("says the control plane does not answer while the stream reconnects, with why, and that the page connects by itself", () => {
    const offline = offlineOf({ stream: "reconnecting", streamDetail: "fetch failed", apiError: null })!;
    expect(offline.title).toBe("The control plane does not answer");
    expect(offline.detail).toContain("fetch failed");
    expect(offline.detail).toContain("out of date");
    expect(offline.detail).toContain("connects again by itself");
  });

  it("says it too when only the health check fails, with what it said", () => {
    const offline = offlineOf({ stream: "open", streamDetail: "", apiError: new Error("the control plane answered 503") })!;
    expect(offline.title).toBe("The control plane does not answer");
    expect(offline.detail).toContain("the control plane answered 503");
  });

  it("tells a stream that ended for good apart: the page does not connect again by itself", () => {
    const offline = offlineOf({ stream: "closed", streamDetail: "the origin was refused (403)", apiError: null })!;
    expect(offline.title).toBe("Live updates have stopped");
    expect(offline.detail).toContain("the origin was refused (403)");
    expect(offline.detail).toContain("reload");
    expect(offline.detail).not.toContain("by itself");
  });
});
