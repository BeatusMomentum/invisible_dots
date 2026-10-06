import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, startSession } from "../src/lib/proxy";

const TOKEN = "t".repeat(40);
let cookie: string | null = null;
vi.mock("next/headers", () => ({ headers: async () => new Headers(cookie === null ? {} : { cookie }) }));

const { dotPageTitle } = await import("../src/lib/dot-title");

const asked: Array<{ url: string; authorization: string | undefined }> = [];
const answers = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
      return Response.json(body, { status });
    }),
  );

beforeEach(() => {
  asked.length = 0;
  cookie = `${SESSION_COOKIE}=${startSession(TOKEN)}`;
  vi.stubEnv("INVISIBLE_DOTS_TOKEN", TOKEN);
  vi.stubEnv("INVISIBLE_DOTS_URL", "http://api.test:7777");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the title of a Dot's page", () => {
  it("names the tab and then the Dot, asked of the control plane with the web server's credential", async () => {
    answers(200, { id: "dot_1", name: "fares" });
    expect(await dotPageTitle("dot_1", "Chat")).toEqual({ title: "Chat - fares" });
    expect(asked).toEqual([{ url: "http://api.test:7777/api/dots/dot_1", authorization: `Bearer ${TOKEN}` }]);
  });

  it("encodes what it asks for, since the address names the Dot by id or by name", async () => {
    answers(200, { name: "a b" });
    await dotPageTitle("a b/../x", "Tasks");
    expect(asked[0]!.url).toBe("http://api.test:7777/api/dots/a%20b%2F..%2Fx");
  });

  it("does not ask, and does not name the Dot, for a request that is not signed in", async () => {
    answers(200, { name: "fares" });
    for (const value of [null, `${SESSION_COOKIE}=${startSession("another token")}`, "idots_session=garbage"]) {
      cookie = value;
      expect(await dotPageTitle("dot_1", "Chat")).toEqual({ title: "Chat" });
    }
    expect(asked).toEqual([]);
  });

  it("settles for the tab when the Dot is not found, the control plane answers badly or does not answer", async () => {
    answers(404, { error: "not_found", message: "no" });
    expect(await dotPageTitle("dot_1", "Chat")).toEqual({ title: "Chat" });
    answers(200, { name: 3 });
    expect(await dotPageTitle("dot_1", "Chat")).toEqual({ title: "Chat" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await dotPageTitle("dot_1", "Chat")).toEqual({ title: "Chat" });
  });

  it("settles for the tab when the web server has no token", async () => {
    vi.stubEnv("INVISIBLE_DOTS_TOKEN", "");
    vi.stubEnv("INVISIBLE_DOTS_HOME", "/nonexistent/idots-home");
    answers(200, { name: "fares" });
    expect(await dotPageTitle("dot_1", "Chat")).toEqual({ title: "Chat" });
    expect(asked).toEqual([]);
  });
});
