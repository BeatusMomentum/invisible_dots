import { InvisibleDotsClient } from "@invisible-dots/sdk";
import { describe, expect, it } from "vitest";
import { ApiError, computerAction, errorIssues } from "../src/lib/api";

describe("errorIssues", () => {
  it("lists the validation details of an API error with dotted paths", () => {
    const error = new ApiError(400, "invalid_config", "invalid Dot configuration", [
      { path: "computer.cpu", message: "too big" },
      { path: ["model", "id"], message: "empty" },
      "a plain problem",
      { path: "ignored" },
    ]);
    expect(errorIssues(error)).toEqual([
      { path: "computer.cpu", message: "too big" },
      { path: "model.id", message: "empty" },
      { path: "", message: "a plain problem" },
    ]);
  });

  it("has nothing to list for other errors", () => {
    expect(errorIssues(new ApiError(409, "computer_stopped", "stopped"))).toEqual([]);
    expect(errorIssues(new Error("boom"))).toEqual([]);
    expect(errorIssues(undefined)).toEqual([]);
  });
});

describe("computerAction", () => {
  it("maps each power button to its lifecycle route", async () => {
    const calls: string[] = [];
    const client = new InvisibleDotsClient({
      baseUrl: "",
      fetch: async (input, init) => {
        calls.push(`${init?.method} ${String(input)}`);
        return Response.json({ accepted: true }, { status: 202 });
      },
    });
    for (const action of ["start", "stop", "reboot"] as const) await computerAction(client, "dot 1", action);
    expect(calls).toEqual([
      "POST /api/dots/dot%201/computer/start",
      "POST /api/dots/dot%201/computer/stop",
      "POST /api/dots/dot%201/computer/reboot",
    ]);
  });
});
