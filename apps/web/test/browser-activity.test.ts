import type { StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { browserCall, identityActivity, isBrowserActivityEvent, mergeBrowserEvents, USING_NOW_SECONDS } from "../src/lib/browser-activity";

let n = 0;
function event(type: string, data: Record<string, unknown>, at: string): StoredEvent {
  n += 1;
  return { id: n, dot_id: "d1", type, data, source: "guest", guest_seq: n, created_at: at } as StoredEvent;
}

const T0 = Date.parse("2026-03-10T12:00:00Z");
const at = (secondsAfter: number) => new Date(T0 + secondsAfter * 1000).toISOString();

function call(tool: string, target: string | undefined, secondsAfter: number, extra: Record<string, unknown> = {}): StoredEvent {
  return event("tool.called", { tool, permission: "browser.act", decision: "allow", ok: true, duration_ms: 100, ...(target === undefined ? {} : { target }), ...extra }, at(secondsAfter));
}

describe("which calls name a browser", () => {
  it("reads the identity from the start of the target, and the detail after the colon", () => {
    expect(browserCall(call("browser_navigate", "shop-ab12: https://example.com/a?q=***", 1))).toMatchObject({ identityId: "shop-ab12", tool: "browser_navigate", detail: "https://example.com/a?q=***", succeeded: true });
    expect(browserCall(call("browser_snapshot", "shop-ab12", 1))).toMatchObject({ identityId: "shop-ab12", detail: null });
    expect(browserCall(call("browser_identity_launch", "shop-ab12", 1))).toMatchObject({ identityId: "shop-ab12" });
    expect(browserCall(call("browser_identity_close", "shop-ab12", 1))).toMatchObject({ identityId: "shop-ab12" });
  });

  it("keeps a URL that has a colon of its own whole", () => {
    expect(browserCall(call("browser_navigate", "shop-ab12: http://host:8080/x", 1))?.detail).toBe("http://host:8080/x");
  });

  it("does not take the name of a new browser for the id of one, nor a list for a use", () => {
    expect(browserCall(call("browser_identity_create", "shopping", 1))).toBeNull();
    expect(browserCall(call("browser_identity_list", undefined, 1))).toBeNull();
  });

  it("ignores a call without a target (it never ran) and a tool that is not a browser's", () => {
    expect(browserCall(call("browser_click", undefined, 1, { decision: "deny", ok: false }))).toBeNull();
    expect(browserCall(call("exec", "ls", 1))).toBeNull();
    expect(browserCall(event("message.assistant", { text: "x" }, at(1)))).toBeNull();
  });

  it("says a call did not succeed when it failed or was cut by a stop", () => {
    expect(browserCall(call("browser_click", "shop-ab12: #buy", 1, { ok: false }))?.succeeded).toBe(false);
    expect(browserCall(call("browser_click", "shop-ab12: #buy", 1, { ok: false, interrupted: true }))?.succeeded).toBe(false);
  });

  it("is the filter for what is kept of the log, and merges in id order without repeats", () => {
    const launched = event("browser.identity.launched", { identity_id: "a", name: "A" }, at(0));
    const nav = call("browser_navigate", "a: https://x.test", 1);
    const other = event("message.assistant", { text: "x" }, at(2));
    expect([launched, nav, other].map(isBrowserActivityEvent)).toEqual([true, true, false]);
    expect(mergeBrowserEvents([nav], [launched, nav, other]).map((e) => e.id)).toEqual([launched.id, nav.id]);
  });
});

describe("what the log says of one browser", () => {
  it("gives the page the Dot last sent it to, and when it last called it", () => {
    const log = [
      event("browser.identity.launched", { identity_id: "a", name: "A" }, at(0)),
      call("browser_navigate", "a: https://one.test", 1),
      call("browser_click", "a: #go", 2),
      call("browser_navigate", "a: https://two.test", 3),
      call("browser_read_text", "a", 4),
    ];
    expect(identityActivity(log, "a", T0 + 100_000)).toEqual({ page: "https://two.test", usingNow: false, lastCallAt: at(4) });
  });

  it("is using it now for a short while after a call, and no longer", () => {
    const log = [call("browser_click", "a: #go", 0)];
    expect(identityActivity(log, "a", T0 + 1000).usingNow).toBe(true);
    expect(identityActivity(log, "a", T0 + USING_NOW_SECONDS * 1000).usingNow).toBe(true);
    expect(identityActivity(log, "a", T0 + USING_NOW_SECONDS * 1000 + 1).usingNow).toBe(false);
  });

  it("does not take another browser's call for this one's", () => {
    const log = [call("browser_navigate", "b: https://other.test", 0), call("browser_click", "b: #x", 1)];
    expect(identityActivity(log, "a", T0 + 2000)).toEqual({ page: null, usingNow: false, lastCallAt: null });
  });

  it("knows no page for a window that was opened, or ended, after the last navigation", () => {
    const opened = [call("browser_navigate", "a: https://old.test", 1), event("browser.identity.closed", { identity_id: "a", name: "A" }, at(2)), event("browser.identity.launched", { identity_id: "a", name: "A" }, at(3))];
    expect(identityActivity(opened, "a", T0 + 4000).page).toBeNull();
    // Another browser opening does not touch this one's page.
    const other = [call("browser_navigate", "a: https://kept.test", 1), event("browser.identity.launched", { identity_id: "b", name: "B" }, at(2))];
    expect(identityActivity(other, "a", T0 + 3000).page).toBe("https://kept.test");
  });

  it("does not count a navigation that failed, or was refused, as the page", () => {
    const log = [call("browser_navigate", "a: https://good.test", 1), call("browser_navigate", "a: https://bad.test", 2, { ok: false })];
    expect(identityActivity(log, "a", T0 + 3000).page).toBe("https://good.test");
  });

  it("keeps the last call's time even when a launch followed the last navigation", () => {
    const log = [call("browser_navigate", "a: https://x.test", 1), event("browser.identity.launched", { identity_id: "a", name: "A" }, at(2)), call("browser_identity_launch", "a", 3)];
    expect(identityActivity(log, "a", T0 + 4000)).toEqual({ page: null, usingNow: true, lastCallAt: at(3) });
  });

  it("allows for a host clock a little ahead of the page's", () => {
    expect(identityActivity([call("browser_click", "a: #x", 5)], "a", T0).usingNow).toBe(true);
  });
});
