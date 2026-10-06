// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStreamProvider } from "../src/components/events";
import { HomePage } from "../src/components/home/HomePage";
import { AttentionProvider } from "../src/components/shell/attention";
import { Toaster } from "../src/components/ui/sonner";
import { stubMatchMedia } from "./support/browser";
import { approvalRecord, dotRecord, FakeControlPlane } from "./support/control-plane";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderHome({ awaitStream = true } = {}) {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <HomePage />
      </AttentionProvider>
      <Toaster />
    </EventStreamProvider>,
  );
  if (awaitStream) await waitFor(() => expect(plane.streamOpen).toBe(true));
}

function card(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

function manyDots(count: number) {
  return Array.from({ length: count }, (_, i) =>
    dotRecord(`d${i}`, { name: `dot-${i}`, config: { goal: i === 3 ? "Sort the mail" : `goal ${i}`, model: { provider: "openrouter", id: "a/b" } } as never }),
  );
}

describe("Home", () => {
  it("re-reads only the spend of the Dot that spent: a message of one Dot does not reload every card", async () => {
    plane.dots = [dotRecord("d1", { name: "first" }), dotRecord("d2", { name: "second" }), dotRecord("d3", { name: "third" })];
    await renderHome();
    await waitFor(() => expect(plane.requests.filter((r) => r.endsWith("/usage"))).toHaveLength(3));
    plane.requests.length = 0;
    plane.spentUsd = 1.25;
    act(() => plane.push("d2", "message.assistant", { text: "done" }));
    await waitFor(() => expect(plane.requests).toContain("GET /api/dots/d2/usage"));
    // Past the refresh delay (300 ms), so a card that was going to reload has done so.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(plane.requests.filter((r) => r.endsWith("/usage"))).toEqual(["GET /api/dots/d2/usage"]);
  });

  it("shows placeholders while the Dots load, and says so when they cannot", async () => {
    plane.dots = [dotRecord("d1")];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/dots") await held;
        return plane.fetch(input, init);
      }),
    );
    await renderHome();
    expect(screen.getByLabelText("Loading the Dots")).toBeTruthy();
    release();
    await screen.findByRole("article", { name: "d1" });
    expect(screen.queryByLabelText("Loading the Dots")).toBeNull();
  });

  it("says when the Dots cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "down", message: "the database is away" }, { status: 503 })));
    await renderHome({ awaitStream: false });
    expect((await screen.findAllByRole("alert")).some((alert) => alert.textContent?.includes("the database is away"))).toBe(true);
  });

  it("invites the person with no Dot to create the first", async () => {
    await renderHome();
    expect(await screen.findByRole("heading", { name: "No Dots yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create your first Dot" }).getAttribute("href")).toBe("/new");
    expect(screen.queryByRole("link", { name: "New Dot" })).toBeNull();
  });

  it("shows no setup checklist to a person with no Dot whose host is ready", async () => {
    await renderHome();
    await screen.findByRole("heading", { name: "No Dots yet" });
    await waitFor(() => expect(plane.requests).toContain("GET /api/doctor"));
    await waitFor(() => expect(screen.queryByText("Checking this computer...")).toBeNull());
    expect(screen.queryByRole("region", { name: "Get this computer ready" })).toBeNull();
    expect(screen.queryByRole("region", { name: "This computer is ready" })).toBeNull();
  });

  it("shows the setup checklist to a person with no Dot whose host lacks something, each item with its command", async () => {
    plane.keyConfigured = false;
    plane.doctor = [{ id: "golden-image", label: "golden image", status: "missing", detail: "none in the images folder", fix: "invisible-dots image build" }];
    await renderHome();
    const checklist = await screen.findByRole("region", { name: "Get this computer ready" });
    expect(within(checklist).getByText(/2 things need attention/)).toBeTruthy();
    expect(within(checklist).getByText("invisible-dots image build")).toBeTruthy();
    expect(within(checklist).getAllByRole("listitem").some((item) => item.textContent?.startsWith("OpenRouter key: Needs attention"))).toBe(true);
    // The key is entered here, and the first Dot can be created at once: the checklist informs, it does not block.
    expect(within(checklist).getByLabelText("OpenRouter API key")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create your first Dot" }).getAttribute("href")).toBe("/new");
  });

  it("keeps the checklist on the page, turned green, when the last thing is fixed", async () => {
    plane.keyConfigured = false;
    plane.keyPushedTo = 1;
    await renderHome();
    const checklist = await screen.findByRole("region", { name: "Get this computer ready" });
    await userEvent.type(within(checklist).getByLabelText("OpenRouter API key"), "sk-or-onboarding");
    await userEvent.click(within(checklist).getByRole("button", { name: "Save key" }));
    expect(await within(checklist).findByText("Saved. Pushed to 1 running Dot.")).toBeTruthy();
    expect(plane.savedKeys).toEqual(["sk-or-onboarding"]);
    const ready = await screen.findByRole("region", { name: "This computer is ready" });
    expect(within(ready).getByText("Everything a Dot needs is in place.")).toBeTruthy();
  });

  it("does not offer the key field when the key is stored and only the host lacks something", async () => {
    plane.doctor = [{ id: "qemu", label: "QEMU", status: "missing", detail: "not found on PATH", fix: "invisible-dots setup" }];
    await renderHome();
    const checklist = await screen.findByRole("region", { name: "Get this computer ready" });
    expect(within(checklist).getByText(/1 thing needs attention/)).toBeTruthy();
    expect(within(checklist).queryByLabelText("OpenRouter API key")).toBeNull();
    expect(within(checklist).queryByLabelText("Replace the key")).toBeNull();
  });

  it("shows no checklist when there are Dots, because the cards are what Home is then for", async () => {
    plane.keyConfigured = false;
    plane.dots = [dotRecord("d1", { name: "first" })];
    await renderHome();
    await screen.findByRole("article", { name: "first" });
    expect(screen.queryByRole("region", { name: "Get this computer ready" })).toBeNull();
  });

  it("shows a card per Dot with its name, goal, state, model and what it spent today", async () => {
    plane.spentUsd = 1.5;
    plane.dots = [dotRecord("d1", { name: "fares", config: { goal: "Watch the fares from Milan to Lisbon", model: { provider: "openrouter", id: "z-ai/glm" } } as never })];
    await renderHome();
    const fares = await screen.findByRole("article", { name: "fares" });
    expect(within(fares).getByText("Watch the fares from Milan to Lisbon")).toBeTruthy();
    expect(within(fares).getByText("Idle")).toBeTruthy();
    expect(within(fares).getByText("z-ai/glm")).toBeTruthy();
    await waitFor(() => expect(within(fares).getByText("$1.50")).toBeTruthy());
    expect(within(fares).getByRole("img", { name: "Ready" })).toBeTruthy();
    expect(within(fares).getByRole("link", { name: "Open chat" }).getAttribute("href")).toBe("/dots/d1/chat");
    expect(within(fares).getByRole("link", { name: "fares" }).getAttribute("href")).toBe("/dots/d1/chat");
    expect(screen.getByRole("link", { name: "New Dot" }).getAttribute("href")).toBe("/new");
  });

  it("says why a Dot is in error, as the control plane recorded it", async () => {
    plane.dots = [dotRecord("d1", { name: "broken", status: "ERROR", error: "the guest never became healthy", computer_state: "ERROR" })];
    await renderHome();
    const broken = await screen.findByRole("article", { name: "broken" });
    expect(within(broken).getByText("Error")).toBeTruthy();
    expect(within(broken).getByText("the guest never became healthy")).toBeTruthy();
    expect(within(broken).getByRole("img", { name: "Needs attention: error" })).toBeTruthy();
  });

  it("shows the approvals that wait, linked to the Dot's approvals in the Inbox", async () => {
    plane.dots = [dotRecord("d1", { name: "asks" }), dotRecord("d2", { name: "quiet" })];
    plane.approvals = [approvalRecord("a1", "d1"), approvalRecord("a2", "d1")];
    await renderHome();
    const asks = await screen.findByRole("article", { name: "asks" });
    await waitFor(() => expect(within(asks).getByRole("link", { name: "2 approvals waiting" }).getAttribute("href")).toBe("/inbox?dot=d1"));
    expect(within(asks).getByRole("img", { name: "Waiting for you" })).toBeTruthy();
    expect(within(card("quiet")).queryByText(/waiting/)).toBeNull();
  });

  it("offers the search only above six Dots, and narrows the cards by name, goal or model", async () => {
    plane.dots = manyDots(6);
    await renderHome();
    await screen.findAllByRole("article");
    expect(screen.queryByRole("searchbox", { name: "Search Dots" })).toBeNull();
    cleanup();

    plane.dots = manyDots(7);
    await renderHome();
    await screen.findAllByRole("article");
    expect(screen.getAllByRole("article")).toHaveLength(7);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search Dots" }), "mail");
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-labelledby"))).toEqual(["dot-d3-name"]);
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search Dots" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search Dots" }), "nothing like this");
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain("No Dot matches");
  });

  it("follows the live stream: the agent's state on its card, and a Dot made elsewhere", async () => {
    plane.dots = [dotRecord("d1", { name: "first" })];
    await renderHome();
    await screen.findByRole("article", { name: "first" });
    act(() => plane.push("d1", "agent.state", { state: "THINKING" }));
    await waitFor(() => expect(within(card("first")).getByText("Thinking...")).toBeTruthy());

    plane.dots = [dotRecord("d1", { name: "first" }), dotRecord("d2", { name: "second", status: "CREATING", computer_state: null })];
    act(() => plane.push("d2", "dot.created", { name: "second" }));
    expect(await screen.findByRole("article", { name: "second" })).toBeTruthy();
    expect(within(card("second")).getByText("Preparing the computer")).toBeTruthy();
    expect(within(card("second")).getByRole("button", { name: "No computer yet" })).toBeTruthy();
  });

  it("stops and starts a Dot's computer from its card", async () => {
    plane.dots = [dotRecord("d1", { name: "power" })];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderHome();
    const power = await screen.findByRole("article", { name: "power" });
    await userEvent.click(within(power).getByRole("button", { name: /^Computer: RUNNING/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Stop" }));
    await waitFor(() => expect(plane.requests).toContain("POST /api/dots/d1/computer/stop"));
  });

  it("asks before stopping the computer of a Dot that is running a task", async () => {
    plane.dots = [dotRecord("d1", { name: "busy", status: "RUNNING" })];
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    window.confirm = confirm;
    await renderHome();
    const busy = await screen.findByRole("article", { name: "busy" });
    await userEvent.click(within(busy).getByRole("button", { name: /^Computer: RUNNING/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Stop" }));
    expect(confirm).toHaveBeenCalled();
    expect(plane.requests).not.toContain("POST /api/dots/d1/computer/stop");
  });
});
