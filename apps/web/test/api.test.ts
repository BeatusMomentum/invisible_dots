import { InvisibleDotsClient } from "@invisible-dots/sdk";
import { describe, expect, it } from "vitest";
import { ApiError, computerAction, errorIssues, fetchOrLogin, onLoginPage } from "../src/lib/api";

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

describe("onLoginPage", () => {
  it("is the login page and nothing under another name", () => {
    expect(onLoginPage("/login")).toBe(true);
    expect(onLoginPage("/login/")).toBe(true);
    expect(onLoginPage("/")).toBe(false);
    expect(onLoginPage("/loginx")).toBe(false);
    expect(onLoginPage("/dots/login")).toBe(false);
  });
});

describe("fetchOrLogin", () => {
  const refused = () =>
    Response.json({ error: "login_required" }, { status: 401, headers: { "x-invisible-dots-login": "required" } });

  function page(pathname: string) {
    const assigned: string[] = [];
    return { pathname, assign: (url: string) => assigned.push(url), assigned };
  }

  it("sends a page without a session to the login page, remembering where it was", async () => {
    const here = page("/dots/dot 1/chat");
    const response = await fetchOrLogin(() => here, async () => refused())("/api/health");
    expect(response.status).toBe(401);
    expect(here.assigned).toEqual(["/login?next=%2Fdots%2Fdot%201%2Fchat"]);
  });

  it("never redirects the login page, which has no session by definition", async () => {
    const here = page("/login");
    const response = await fetchOrLogin(() => here, async () => refused())("/api/health");
    expect(response.status).toBe(401);
    expect(here.assigned).toEqual([]);
  });

  it("leaves every other answer alone", async () => {
    const here = page("/");
    const other = [
      Response.json({ error: "unauthorized" }, { status: 401 }),
      Response.json({ error: "login_required" }, { status: 403, headers: { "x-invisible-dots-login": "required" } }),
      Response.json({ ok: true }),
    ];
    for (const answer of other) {
      const response = await fetchOrLogin(() => here, async () => answer)("/api/health");
      expect(response).toBe(answer);
    }
    expect(here.assigned).toEqual([]);
  });

  it("redirects nothing where there is no page", async () => {
    const response = await fetchOrLogin(() => null, async () => refused())("/api/health");
    expect(response.status).toBe(401);
  });
});
