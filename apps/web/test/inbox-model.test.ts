import { describe, expect, it } from "vitest";
import { readDismissed, writeDismissed } from "../src/lib/dismissed";
import { FAILED_WINDOW_MS, failedRecently, loadFailedTasks, recentFailures } from "../src/lib/failed-tasks";
import { historyOrder, inboxHref, matchesFilters, parseInboxQuery, resolveDotFilter, waitingOrder } from "../src/lib/inbox";
import { approvalRecord, taskRecord } from "./support/control-plane";

describe("the Inbox's address", () => {
  it("reads the tab and the filters, and takes the first of a repeated one", () => {
    expect(parseInboxQuery({})).toEqual({ tab: "needs-you", dot: null, permission: null });
    expect(parseInboxQuery({ tab: "history", dot: "fares", permission: "files.write" })).toEqual({ tab: "history", dot: "fares", permission: "files.write" });
    expect(parseInboxQuery({ dot: ["a", "b"] }).dot).toBe("a");
    // A tab it does not know, and an empty filter, are the defaults.
    expect(parseInboxQuery({ tab: "nope", dot: "", permission: [] })).toEqual({ tab: "needs-you", dot: null, permission: null });
  });

  it("writes only what is not the default, and what it writes it reads back", () => {
    expect(inboxHref()).toBe("/inbox");
    expect(inboxHref({ tab: "needs-you", dot: null, permission: null })).toBe("/inbox");
    expect(inboxHref({ dot: "d 1" })).toBe("/inbox?dot=d+1");
    expect(inboxHref({ tab: "history", permission: "browser.act" })).toBe("/inbox?tab=history&permission=browser.act");
    const query = { tab: "history" as const, dot: "a&b=c", permission: "files.write" };
    expect(parseInboxQuery(Object.fromEntries(new URL(inboxHref(query), "http://x").searchParams))).toEqual(query);
  });
});

describe("what the filters keep", () => {
  const dots = [
    { id: "dot_1", name: "fares" },
    { id: "dot_2", name: "mailer" },
  ];

  it("takes a Dot's id or its name for the Dot, and keeps what it cannot resolve (a deleted Dot's approvals can still be asked for)", () => {
    expect(resolveDotFilter(null, dots)).toBeNull();
    expect(resolveDotFilter("dot_2", dots)).toBe("dot_2");
    expect(resolveDotFilter("fares", dots)).toBe("dot_1");
    expect(resolveDotFilter("dot_gone", dots)).toBe("dot_gone");
    expect(resolveDotFilter("fares", [])).toBe("fares");
  });

  it("keeps what is of the Dot and the permission asked for, and everything when none is", () => {
    expect(matchesFilters(null, null, "dot_1", "files.write")).toBe(true);
    expect(matchesFilters("dot_1", null, "dot_1", "files.write")).toBe(true);
    expect(matchesFilters("dot_1", null, "dot_2", "files.write")).toBe(false);
    expect(matchesFilters(null, "files.write", "dot_2", "files.write")).toBe(true);
    expect(matchesFilters(null, "files.write", "dot_2", "computer.exec")).toBe(false);
    expect(matchesFilters("dot_1", "files.write", "dot_1", "computer.exec")).toBe(false);
  });
});

describe("the order of the lists", () => {
  it("puts the answered approvals last answered first, and leaves the waiting ones out of the history", () => {
    const rows = [
      approvalRecord("old", "d", { status: "approved", created_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-01T00:05:00Z" }),
      approvalRecord("new", "d", { status: "rejected", created_at: "2026-01-02T00:00:00Z", resolved_at: "2026-01-02T00:01:00Z" }),
      approvalRecord("waiting", "d", { created_at: "2026-01-03T00:00:00Z" }),
      approvalRecord("expired", "d", { status: "expired", created_at: "2026-01-01T12:00:00Z", resolved_at: null }),
    ];
    expect(historyOrder(rows).map((row) => row.id)).toEqual(["new", "expired", "old"]);
  });

  it("puts the approval that has waited longest first, and breaks a tie by id", () => {
    const items = [
      { id: "c", createdAt: "2026-01-02T00:00:00Z" },
      { id: "b", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a", createdAt: "2026-01-01T00:00:00Z" },
    ];
    expect(waitingOrder(items).map((item) => item.id)).toEqual(["a", "b", "c"]);
    // The list given is not changed.
    expect(items[0]!.id).toBe("c");
  });
});

describe("the tasks that failed lately", () => {
  const now = Date.parse("2026-03-10T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("are those that failed less than a day ago, and no other state, and none that claim to have ended in the future", () => {
    expect(failedRecently({ status: "FAILED", finished_at: ago(60_000) }, now)).toBe(true);
    expect(failedRecently({ status: "FAILED", finished_at: ago(FAILED_WINDOW_MS - 1) }, now)).toBe(true);
    expect(failedRecently({ status: "FAILED", finished_at: ago(FAILED_WINDOW_MS) }, now)).toBe(false);
    expect(failedRecently({ status: "COMPLETED", finished_at: ago(1) }, now)).toBe(false);
    expect(failedRecently({ status: "CANCELLED", finished_at: ago(1) }, now)).toBe(false);
    expect(failedRecently({ status: "FAILED", finished_at: null }, now)).toBe(false);
    expect(failedRecently({ status: "FAILED", finished_at: "garbage" }, now)).toBe(false);
    expect(failedRecently({ status: "FAILED", finished_at: new Date(now + 3_600_000).toISOString() }, now)).toBe(false);
  });

  it("are read from every Dot's tasks, newest failure first, and a Dot that cannot be read is counted, not hidden", async () => {
    const tasksOf: Record<string, ReturnType<typeof taskRecord>[]> = {
      d1: [taskRecord("a", { dot_id: "d1", status: "FAILED", finished_at: ago(3_600_000) }), taskRecord("fine", { dot_id: "d1", status: "COMPLETED", finished_at: ago(1) })],
      d2: [taskRecord("b", { dot_id: "d2", status: "FAILED", finished_at: ago(60_000) }), taskRecord("stale", { dot_id: "d2", status: "FAILED", finished_at: ago(2 * FAILED_WINDOW_MS) })],
    };
    const client = {
      listTasks: async (id: string) => {
        if (id === "broken") throw new Error("down");
        return tasksOf[id] ?? [];
      },
    };
    const loaded = await loadFailedTasks(client, [{ id: "d1" }, { id: "d2" }, { id: "broken" }], now);
    expect(loaded.tasks.map((task) => task.id)).toEqual(["b", "a"]);
    expect(loaded.unread).toBe(1);
    expect(await loadFailedTasks(client, [], now)).toEqual({ tasks: [], unread: 0 });
  });

  it("leave the Inbox when they are dismissed, and when a day has passed since they failed", () => {
    const tasks = [taskRecord("a", { status: "FAILED", finished_at: ago(3_600_000) }), taskRecord("b", { status: "FAILED", finished_at: ago(FAILED_WINDOW_MS - 60_000) })];
    expect(recentFailures(tasks, new Set(), now).map((task) => task.id)).toEqual(["a", "b"]);
    expect(recentFailures(tasks, new Set(["a"]), now).map((task) => task.id)).toEqual(["b"]);
    expect(recentFailures(tasks, new Set(), now + 120_000).map((task) => task.id)).toEqual(["a"]);
  });
});

describe("the dismissed tasks kept in the browser", () => {
  function storage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
  }

  it("come back as they were written", () => {
    const store = storage();
    expect(readDismissed(store).size).toBe(0);
    writeDismissed(["a", "b"], store);
    expect([...readDismissed(store)]).toEqual(["a", "b"]);
  });

  it("keep only the newest 200", () => {
    const store = storage();
    writeDismissed(Array.from({ length: 250 }, (_, i) => `t${i}`), store);
    const kept = [...readDismissed(store)];
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe("t50");
    expect(kept.at(-1)).toBe("t249");
  });

  it("are none when the stored text is not a list of ids, when storage is missing, and when it refuses", () => {
    expect(readDismissed(storage({ "idots.dismissed-tasks": "{not json" })).size).toBe(0);
    expect(readDismissed(storage({ "idots.dismissed-tasks": '{"a":1}' })).size).toBe(0);
    expect([...readDismissed(storage({ "idots.dismissed-tasks": '["a",3,null,"b"]' }))]).toEqual(["a", "b"]);
    expect(readDismissed(null).size).toBe(0);
    expect(() => writeDismissed(["a"], null)).not.toThrow();
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDismissed(refusing).size).toBe(0);
    expect(() => writeDismissed(["a"], refusing)).not.toThrow();
  });
});
