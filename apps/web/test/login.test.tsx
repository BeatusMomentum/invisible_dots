// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "../src/components/login/LoginForm";

let fetchMock: ReturnType<typeof vi.fn>;
const assign = vi.fn();

beforeEach(() => {
  assign.mockClear();
  fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/login");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tokenField = () => screen.getByLabelText("API token") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /^Sign in|Signing in/ }) as HTMLButtonElement;

describe("the login form", () => {
  it("says where the token is, hides what is typed and waits for a token before it lets the person submit", () => {
    render(<LoginForm assign={assign} />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText(/config\/api\.token/)).toBeTruthy();
    expect(tokenField().type).toBe("password");
    expect(tokenField().getAttribute("aria-describedby")).toBe("api-token-hint");
    expect(document.activeElement).toBe(tokenField());
    expect(submit().disabled).toBe(true);
  });

  it("sends the token once to /session and goes to the page the person came from", async () => {
    window.history.replaceState(null, "", "/login?next=%2Fdots%2Fd1%2Ftasks");
    render(<LoginForm assign={assign} />);
    await userEvent.type(tokenField(), "the-token");
    await userEvent.click(submit());
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/dots/d1/tasks"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token: "the-token" });
  });

  it("never goes anywhere else than a page of this site", async () => {
    window.history.replaceState(null, "", "/login?next=https%3A%2F%2Felsewhere.example%2F");
    render(<LoginForm assign={assign} />);
    await userEvent.type(tokenField(), "the-token");
    await userEvent.click(submit());
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("shows the server's refusal as an alert, keeps the token typed and goes nowhere", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "unauthorized", message: "that is not the API token" }, { status: 401 }));
    render(<LoginForm assign={assign} />);
    await userEvent.type(tokenField(), "wrong");
    await userEvent.click(submit());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not sign in");
    expect(alert.textContent).toContain("that is not the API token");
    expect(tokenField().value).toBe("wrong");
    expect(assign).not.toHaveBeenCalled();
    expect(submit().disabled).toBe(false);
  });

  it("falls back to the status when the refusal has no message", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
    render(<LoginForm assign={assign} />);
    await userEvent.type(tokenField(), "x");
    await userEvent.click(submit());
    expect((await screen.findByRole("alert")).textContent).toContain("sign-in failed (502)");
  });

  it("says when the server cannot be reached, and clears the alert on the next try", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<LoginForm assign={assign} />);
    await userEvent.type(tokenField(), "x");
    await userEvent.click(submit());
    expect((await screen.findByRole("alert")).textContent).toContain("network down");
    await userEvent.click(submit());
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
