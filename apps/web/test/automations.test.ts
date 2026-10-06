import type { Automation } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { describeEvery, describeSchedule, emptyAutomationsText, lastRunOf, nextRunLabel, sortAutomations, whenLabel } from "../src/lib/automations";

const cron = (expr: string, tz?: string) => describeSchedule({ kind: "cron", expr, ...(tz ? { tz } : {}) }, "en-US");

function automation(id: string, change: Partial<Automation> = {}): Automation {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: "every", every_ms: 60_000 },
    message: "do it",
    next_run_at_ms: 1_000,
    last_run_at_ms: null,
    last_status: null,
    last_error: null,
    delete_after_run: false,
    created_at_ms: 0,
    ...change,
  };
}

describe("an interval in words", () => {
  it("uses the largest unit that divides it", () => {
    expect(describeEvery(1000)).toBe("every second");
    expect(describeEvery(45_000)).toBe("every 45 seconds");
    expect(describeEvery(60_000)).toBe("every minute");
    expect(describeEvery(30 * 60_000)).toBe("every 30 minutes");
    expect(describeEvery(90 * 60_000)).toBe("every 90 minutes");
    expect(describeEvery(3_600_000)).toBe("every hour");
    expect(describeEvery(6 * 3_600_000)).toBe("every 6 hours");
    expect(describeEvery(86_400_000)).toBe("every day");
    expect(describeEvery(2 * 86_400_000)).toBe("every 2 days");
  });

  it("never says every 0 seconds", () => {
    expect(describeEvery(400)).toBe("every second");
  });
});

describe("a cron schedule in words", () => {
  it("says the time of day, and the zone it is read in", () => {
    expect(cron("0 9 * * *", "Europe/Rome")).toBe("every day at 09:00 (Europe/Rome)");
    expect(cron("30 18 * * *")).toBe("every day at 18:30 (the computer's time zone)");
  });

  it("names the days of the week", () => {
    expect(cron("0 9 * * 1-5", "UTC")).toBe("every weekday at 09:00 (UTC)");
    expect(cron("0 10 * * 6,0", "UTC")).toBe("every weekend day at 10:00 (UTC)");
    expect(cron("0 9 * * 1", "UTC")).toBe("every Monday at 09:00 (UTC)");
    expect(cron("0 9 * * 1,3,5", "UTC")).toBe("every Monday, Wednesday and Friday at 09:00 (UTC)");
    expect(cron("0 9 * * 7", "UTC")).toBe("every Sunday at 09:00 (UTC)");
    expect(cron("0 9 * * 0-6", "UTC")).toBe("every day at 09:00 (UTC)");
  });

  it("reads the common intervals", () => {
    expect(cron("* * * * *", "UTC")).toBe("every minute (UTC)");
    expect(cron("*/15 * * * *", "UTC")).toBe("every 15 minutes (UTC)");
    expect(cron("0 * * * *", "UTC")).toBe("every hour, on the hour (UTC)");
    expect(cron("20 * * * *", "UTC")).toBe("every hour at minute 20 (UTC)");
    expect(cron("0 */2 * * *", "UTC")).toBe("every 2 hours (UTC)");
    expect(cron("15 */4 * * *", "UTC")).toBe("every 4 hours at minute 15 (UTC)");
  });

  it("reads a day of the month", () => {
    expect(cron("0 8 1 * *", "UTC")).toBe("on day 1 of every month at 08:00 (UTC)");
    expect(cron("0 8 1,15 * *", "UTC")).toBe("on day 1 and 15 of every month at 08:00 (UTC)");
  });

  it("shows an expression it cannot put in words as the expression, never a guess", () => {
    for (const expr of ["0 9 * 6 *", "0 9 1 * 1", "0,30 9 * * *", "0 9-17 * * *", "0 9 * * mon", "0 9 * *", "*/0 * * * *", "0 9 * * 8", "0 24 * * *"]) {
      expect(cron(expr, "UTC"), expr).toBe(`cron "${expr}" (UTC)`);
    }
  });
});

describe("the schedules that are not cron", () => {
  it("says an interval in words", () => {
    expect(describeSchedule({ kind: "every", every_ms: 1_800_000 })).toBe("every 30 minutes");
  });

  it("says a one-time schedule with its moment in the reader's zone", () => {
    const at = Date.UTC(2026, 2, 10, 9, 0);
    expect(describeSchedule({ kind: "at", at_ms: at }, "en-US")).toBe(`once, ${whenLabel(at, "en-US")}`);
    expect(whenLabel(at, "en-US")).toMatch(/^Mar 10, 2026(?:,| at) \d{1,2}:\d{2}\s?[AP]M$/);
  });

  it("does not invent what the engine left out", () => {
    expect(describeSchedule({ kind: "at" })).toBe("once");
    expect(describeSchedule({ kind: "every" })).toBe("on an interval");
    expect(describeSchedule({ kind: "cron" }, "en-US")).toBe(`cron "" (the computer's time zone)`);
  });
});

describe("when it runs next, and how the last run went", () => {
  const now = Date.UTC(2026, 2, 10, 8, 0);

  it("says the moment and how far away it is", () => {
    const at = now + 3 * 3_600_000;
    expect(nextRunLabel({ enabled: true, next_run_at_ms: at }, now, "en-US")).toBe(`${whenLabel(at, "en-US")} (in 3h)`);
  });

  it("says Paused for a paused automation, whatever its next run was", () => {
    expect(nextRunLabel({ enabled: false, next_run_at_ms: now + 1000 }, now)).toBe("Paused");
    expect(nextRunLabel({ enabled: false, next_run_at_ms: null }, now)).toBe("Paused");
  });

  it("says when no run is left", () => {
    expect(nextRunLabel({ enabled: true, next_run_at_ms: null }, now)).toBe("No run left");
  });

  it("has no last run before the first", () => {
    expect(lastRunOf({ last_run_at_ms: null, last_status: null, last_error: null }, now)).toBeNull();
  });

  it("carries how the last run ended and what went wrong", () => {
    const ran = now - 2 * 3_600_000;
    expect(lastRunOf({ last_run_at_ms: ran, last_status: "error", last_error: "the page did not load" }, now, "en-US")).toEqual({
      at: `${whenLabel(ran, "en-US")} (2h ago)`,
      status: "error",
      error: "the page did not load",
    });
    expect(lastRunOf({ last_run_at_ms: ran, last_status: "skipped", last_error: null }, now)?.status).toBe("skipped");
  });

  it("takes a run without a status as having run", () => {
    expect(lastRunOf({ last_run_at_ms: now, last_status: null, last_error: null }, now)?.status).toBe("ok");
  });
});

describe("the order of the automations", () => {
  it("puts the ones that run soonest first, then the spent, then the paused", () => {
    const sorted = sortAutomations([
      automation("paused", { enabled: false, next_run_at_ms: null }),
      automation("later", { next_run_at_ms: 9_000 }),
      automation("spent", { next_run_at_ms: null }),
      automation("soon", { next_run_at_ms: 1_000 }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["soon", "later", "spent", "paused"]);
  });

  it("breaks a tie by name, whatever its case, then by id, and leaves its input alone", () => {
    const input = [automation("b2", { name: "beta" }), automation("a2", { name: "Alpha" }), automation("a1", { name: "Alpha" })];
    expect(sortAutomations(input).map((a) => a.id)).toEqual(["a1", "a2", "b2"]);
    expect(input.map((a) => a.id)).toEqual(["b2", "a2", "a1"]);
  });
});

describe("what an empty list says about how an automation comes to be", () => {
  it("says the Dot asks first when the permission asks, which is the default", () => {
    expect(emptyAutomationsText({ permissions: {} })).toMatch(/asks you first/);
    expect(emptyAutomationsText({ permissions: { automations: "ask" } })).toMatch(/asks you first/);
    expect(emptyAutomationsText(undefined)).toMatch(/asks you first/);
  });

  it("says it may set them up on its own when the permission allows", () => {
    expect(emptyAutomationsText({ permissions: { automations: "allow" } })).toMatch(/on its own/);
  });

  it("says it cannot when the permission is denied", () => {
    expect(emptyAutomationsText({ permissions: { automations: "deny" } })).toMatch(/cannot set any up/);
  });
});
