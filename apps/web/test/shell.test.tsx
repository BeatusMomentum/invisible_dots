// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppLayout from "../src/app/(app)/layout";
import LoginLayout from "../src/app/login/layout";
import LoginPage from "../src/app/login/page";
import { stubMatchMedia } from "./support/browser";
import { approvalRecord, dotRecord, FakeControlPlane } from "./support/control-plane";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  pathname = "/";
  document.title = "Dots - invisible_dots";
  plane = new FakeControlPlane();
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell() {
  return render(
    <AppLayout>
      <p>content</p>
    </AppLayout>,
  );
}

const rail = () => screen.getByRole("complementary", { name: "Navigation" });

describe("the login page", () => {
  it("has no rail and asks the API nothing, because there is no session to ask with", async () => {
    render(
      <LoginLayout>
        <LoginPage />
      </LoginLayout>,
    );
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    // Let any request an effect would start go out before looking.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plane.requests).toEqual([]);
  });
});

describe("the rail", () => {
  it("lists every Dot with the ring that says what it is doing, and the approvals that wait", async () => {
    plane.dots = [
      dotRecord("quiet", { name: "quiet" }),
      dotRecord("stopped", { name: "stopped", computer_state: "STOPPED" }),
      dotRecord("broken", { name: "broken", status: "ERROR", error: "the disk is full", computer_state: "ERROR" }),
      dotRecord("asking", { name: "asking", status: "WAITING_APPROVAL" }),
    ];
    plane.approvals = [approvalRecord("a1", "asking"), approvalRecord("a2", "asking"), approvalRecord("a3", "quiet", { status: "approved" })];
    renderShell();

    const dots = within(await screen.findByRole("navigation", { name: "Dots" }));
    await waitFor(() => expect(dots.getAllByRole("link")).toHaveLength(4));
    const ringOf = (name: string) => dots.getByRole("link", { name: new RegExp(name) }).querySelector("[data-ring]")?.getAttribute("data-ring");
    expect(ringOf("quiet")).toBe("ready");
    expect(ringOf("stopped")).toBe("stopped");
    expect(ringOf("broken")).toBe("error");
    expect(ringOf("asking")).toBe("waiting");
    expect(within(dots.getByRole("link", { name: /asking/ })).getByLabelText("2 waiting")).toBeTruthy();
    expect(within(dots.getByRole("link", { name: /quiet/ })).queryByLabelText(/waiting$/)).toBeNull();
    expect(dots.getByRole("link", { name: /asking/ }).getAttribute("href")).toBe("/dots/asking/chat");
    // The Approvals entry carries the total.
    expect(within(screen.getByRole("link", { name: /^Approvals/ })).getByLabelText("2 waiting")).toBeTruthy();
  });

  it("marks the page that is open, the Dot's page included", async () => {
    plane.dots = [dotRecord("one"), dotRecord("two")];
    pathname = "/dots/two/tasks";
    renderShell();
    const dots = within(await screen.findByRole("navigation", { name: "Dots" }));
    await waitFor(() => expect(dots.getAllByRole("link")).toHaveLength(2));
    expect(dots.getByRole("link", { name: /two/ }).getAttribute("aria-current")).toBe("page");
    expect(dots.getByRole("link", { name: /one/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("says so when there are no Dots, and when the list cannot be loaded, and offers a retry", async () => {
    renderShell();
    expect(await screen.findByText("No Dots yet.")).toBeTruthy();
    cleanup();

    plane.dots = [];
    const failing = vi.fn(() => Promise.resolve(Response.json({ error: "down", message: "down" }, { status: 503 })));
    vi.stubGlobal("fetch", failing);
    renderShell();
    const alert = await screen.findByText(/Could not load the Dots/);
    expect(alert).toBeTruthy();
    const calls = failing.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(failing.mock.calls.length).toBeGreaterThan(calls));
  });

  it("shows the API's state and version, and says that no key is stored yet", async () => {
    plane.keyConfigured = false;
    renderShell();
    await waitFor(() => expect(within(rail()).getByText("API: ok")).toBeTruthy());
    expect(within(rail()).getByText("v9.9.9")).toBeTruthy();
    expect(within(rail()).getByText("No OpenRouter key stored yet")).toBeTruthy();
  });

  it("sends the person from the missing key to the settings page where it is entered", async () => {
    plane.keyConfigured = false;
    renderShell();
    const warning = await within(rail()).findByRole("link", { name: "No OpenRouter key stored yet" });
    expect(warning.getAttribute("href")).toBe("/settings");
  });

  it("has a Settings page in the main navigation, marked as the current page while it is open", async () => {
    pathname = "/settings";
    renderShell();
    const link = await within(rail()).findByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("/settings");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(within(rail()).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("learns that a key was stored from the next health answer, without a reload of the page", async () => {
    plane.keyConfigured = false;
    // Faked before the shell starts, so that its 30 second timer is the faked one. The shell asks every 30 seconds;
    // a saved key asks at once through the shared resource (settings.test.tsx).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderShell();
      await within(rail()).findByText("No OpenRouter key stored yet");
      plane.keyConfigured = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await waitFor(() => expect(within(rail()).queryByText("No OpenRouter key stored yet")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when the API cannot be reached", async () => {
    plane.healthy = false;
    renderShell();
    await waitFor(() => expect(within(rail()).getByText("API: unreachable")).toBeTruthy());
  });

  it("shows whether live updates arrive", async () => {
    renderShell();
    await waitFor(() => expect(within(rail()).getByText("Live")).toBeTruthy());
  });

  it("offers a way to create a Dot, which is the create page", async () => {
    renderShell();
    expect(screen.getByRole("link", { name: "New Dot" }).getAttribute("href")).toBe("/new");
  });

  it("says so, and stays signed in, when the server cannot end the session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/session" ? new Response(null, { status: 500 }) : plane.fetch(input, init),
      ),
    );
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("sign-out failed (500)");
    expect(screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("what the live stream changes in the rail", () => {
  it("counts a new approval at once, and drops it when it is answered", async () => {
    plane.dots = [dotRecord("d1")];
    renderShell();
    await waitFor(() => expect(plane.streamOpen).toBe(true));
    await screen.findByRole("link", { name: /d1/ });
    expect(screen.queryByLabelText("1 waiting")).toBeNull();

    plane.approvals = [approvalRecord("a1", "d1")];
    act(() => plane.push("d1", "approval.requested", { approval_id: "a1" }));
    const dots = within(screen.getByRole("navigation", { name: "Dots" }));
    await waitFor(() => expect(within(dots.getByRole("link", { name: /d1/ })).getByLabelText("1 waiting")).toBeTruthy());
    expect(within(dots.getByRole("link", { name: /d1/ })).getByRole("img", { name: "Waiting for you" })).toBeTruthy();

    plane.approvals = [];
    act(() => plane.push("d1", "approval.resolved", { approval_id: "a1", decision: "approve" }));
    await waitFor(() => expect(screen.queryByLabelText("1 waiting")).toBeNull());
  });

  it("shows the ring of a Dot that is working from the agent's own events", async () => {
    plane.dots = [dotRecord("d1")];
    renderShell();
    await waitFor(() => expect(plane.streamOpen).toBe(true));
    const link = await screen.findByRole("link", { name: /d1/ });
    act(() => plane.push("d1", "agent.state", { state: "THINKING" }));
    await waitFor(() => expect(link.querySelector("[data-ring]")?.getAttribute("data-ring")).toBe("working"));
    act(() => plane.push("d1", "agent.state", { state: "IDLE" }));
    await waitFor(() => expect(link.querySelector("[data-ring]")?.getAttribute("data-ring")).toBe("ready"));
  });

  it("marks a reply that arrives while another page is open, and clears the mark when the Dot is opened", async () => {
    plane.dots = [dotRecord("d1"), dotRecord("d2")];
    const view = renderShell();
    await waitFor(() => expect(plane.streamOpen).toBe(true));
    await screen.findByRole("link", { name: /d1/ });
    act(() => plane.push("d1", "message.assistant", { text: "done" }));
    await waitFor(() => expect(screen.getByRole("img", { name: "New reply" })).toBeTruthy());
    expect(within(screen.getByRole("link", { name: /d2/ })).queryByRole("img", { name: "New reply" })).toBeNull();

    pathname = "/dots/d1/chat";
    view.rerender(
      <AppLayout>
        <p>content</p>
      </AppLayout>,
    );
    await waitFor(() => expect(screen.queryByRole("img", { name: "New reply" })).toBeNull());
  });

  it("puts the count of what needs the person in the tab title, and takes it out again", async () => {
    plane.dots = [dotRecord("d1"), dotRecord("d2", { status: "ERROR", error: "x", computer_state: "ERROR" })];
    plane.approvals = [approvalRecord("a1", "d1")];
    renderShell();
    await waitFor(() => expect(document.title).toBe("(2) Dots - invisible_dots"));
    expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toContain(encodeURIComponent("#c96a00"));

    plane.approvals = [];
    plane.dots = [dotRecord("d1"), dotRecord("d2")];
    await waitFor(() => expect(plane.streamOpen).toBe(true));
    act(() => {
      plane.push("d1", "approval.resolved", { approval_id: "a1", decision: "approve" });
      plane.push("d2", "dot.updated");
    });
    await waitFor(() => expect(document.title).toBe("Dots - invisible_dots"));
    expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).not.toContain(encodeURIComponent("#c96a00"));
  });

  it("puts the prefix back when the page writes a new title", async () => {
    plane.dots = [dotRecord("d1", { status: "ERROR", error: "x", computer_state: "ERROR" })];
    renderShell();
    await waitFor(() => expect(document.title).toBe("(1) Dots - invisible_dots"));
    act(() => {
      document.title = "Chat - invisible_dots";
    });
    await waitFor(() => expect(document.title).toBe("(1) Chat - invisible_dots"));
  });
});

describe("the menu on a narrow screen", () => {
  it("opens the same rail as a sheet, and closes it when a page is chosen", async () => {
    plane.dots = [dotRecord("d1")];
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    const sheet = await screen.findByRole("dialog");
    const link = await within(sheet).findByRole("link", { name: /d1/ });
    expect(within(sheet).getByRole("button", { name: "Sign out" })).toBeTruthy();
    // jsdom cannot navigate: the click is still heard by the page, which is what closes the sheet.
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await userEvent.click(link);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
