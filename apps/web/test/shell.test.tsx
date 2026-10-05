// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppLayout from "../src/app/(app)/layout";
import LoginLayout from "../src/app/login/layout";
import LoginPage from "../src/app/login/page";

let requests: string[];

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return String(input) === "/session" ? new Response(null, { status: 500 }) : Response.json({ ok: true });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the login page", () => {
  it("has no header and asks the API nothing, because there is no session to ask with", async () => {
    render(
      <LoginLayout>
        <LoginPage />
      </LoginLayout>,
    );
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    // Let any request an effect would start go out before looking.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([]);
  });
});

describe("the signed-in shell", () => {
  it("shows the navigation, the API check and the sign-out button", async () => {
    render(
      <AppLayout>
        <p>content</p>
      </AppLayout>,
    );
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("API: ok"));
    expect(requests).toContain("GET /api/health");
  });

  it("says so, and stays signed in, when the server cannot end the session", async () => {
    render(
      <AppLayout>
        <p>content</p>
      </AppLayout>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("sign-out failed (500)");
    expect(requests).toContain("DELETE /session");
    expect(screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled")).toBe(false);
  });
});
