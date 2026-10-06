import type { HealthResponse } from "@invisible-dots/sdk";
import { describe, expect, it } from "vitest";
import { aboutRows, keySavedMessage } from "../src/lib/host-settings";

const HEALTH: HealthResponse = {
  status: "ok",
  database: "ok",
  version: "1.4.0",
  openrouter_configured: true,
  database_kind: "pglite",
  data_dir: "C:/Users/me/.invisible-dots",
  logs_dir: "C:/Users/me/.invisible-dots/logs",
};

describe("keySavedMessage", () => {
  it("says that no computer was running when none was given the key, and when it arrives", () => {
    expect(keySavedMessage(0)).toBe("Saved. No Dot's computer is running, so each gets the key when it starts.");
  });

  it("counts the running Dots it was pushed to, in the singular for one", () => {
    expect(keySavedMessage(1)).toBe("Saved. Pushed to 1 running Dot.");
    expect(keySavedMessage(3)).toBe("Saved. Pushed to 3 running Dots.");
  });
});

describe("aboutRows", () => {
  it("lists the version, the database, the two directories and the command for a Dot's logs, in that order", () => {
    expect(aboutRows(HEALTH)).toEqual([
      { label: "Version", value: "1.4.0" },
      { label: "Database", value: "Embedded PostgreSQL (PGlite), inside the server" },
      { label: "Data directory", value: "C:/Users/me/.invisible-dots", code: true },
      { label: "Logs directory", value: "C:/Users/me/.invisible-dots/logs", code: true },
      { label: "A Dot's logs", value: "invisible-dots logs <dot>", code: true },
    ]);
  });

  it("names an external database as the one the environment points at", () => {
    expect(aboutRows({ ...HEALTH, database_kind: "pg" })[1]).toEqual({ label: "Database", value: "External PostgreSQL (DATABASE_URL)" });
  });
});
