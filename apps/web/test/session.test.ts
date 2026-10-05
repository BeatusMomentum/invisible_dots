import { describe, expect, it } from "vitest";
import { SignOutError, pathAfterLogin, signOut } from "../src/lib/session";

describe("signOut", () => {
  it("clears the session with DELETE /session, then loads the login page", async () => {
    const calls: string[] = [];
    const assigned: string[] = [];
    await signOut(
      (url) => assigned.push(url),
      async (input, init) => {
        calls.push(`${init?.method} ${String(input)}`);
        return new Response(null, { status: 204 });
      },
    );
    expect(calls).toEqual(["DELETE /session"]);
    expect(assigned).toEqual(["/login"]);
  });

  it("stays on the page when the server refuses, and says so", async () => {
    const assigned: string[] = [];
    const attempt = signOut(
      (url) => assigned.push(url),
      async () => Response.json({ error: "forbidden" }, { status: 403 }),
    );
    await expect(attempt).rejects.toBeInstanceOf(SignOutError);
    await expect(attempt).rejects.toThrow("sign-out failed (403)");
    expect(assigned).toEqual([]);
  });
});

describe("pathAfterLogin", () => {
  it("returns to the page the person came from", () => {
    expect(pathAfterLogin("?next=%2Fdots%2Fabc%2Fchat")).toBe("/dots/abc/chat");
    expect(pathAfterLogin("?next=%2Fapprovals%3Fdot%3Dabc%23top")).toBe("/approvals?dot=abc#top");
  });

  it("goes home without a usable next", () => {
    expect(pathAfterLogin("")).toBe("/");
    expect(pathAfterLogin("?next=")).toBe("/");
    expect(pathAfterLogin("?next=dots")).toBe("/");
  });

  it("never leaves this site", () => {
    expect(pathAfterLogin("?next=https%3A%2F%2Fevil.example%2F")).toBe("/");
    expect(pathAfterLogin("?next=%2F%2Fevil.example%2Fx")).toBe("/");
    expect(pathAfterLogin("?next=%2F%5Cevil.example")).toBe("/");
  });

  it("never returns to the login page, where the person would stay", () => {
    expect(pathAfterLogin("?next=%2Flogin")).toBe("/");
    expect(pathAfterLogin("?next=%2Flogin%3Fnext%3D%2Fdots")).toBe("/");
    expect(pathAfterLogin("?next=%2Flogin%2F")).toBe("/");
  });
});
