// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { Toaster } from "../src/components/ui/sonner";
import { stubMatchMedia } from "./support/browser";
import { approvalRecord, channelRecord, dotRecord, FakeControlPlane } from "./support/control-plane";

let pathname = "/dots/d1/chat";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  pathname = "/dots/d1/chat";
  plane = new FakeControlPlane();
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderDot(id = "d1") {
  const view = render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId={id}>
          <DotShell dotId={id}>
            <p>the tab body</p>
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
      <Toaster />
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 1 });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
  return view;
}

describe("the Dot header", () => {
  it("shows the Dot's name, its goal on one line that opens on a click, and the tab's body below", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: { goal: "Watch fares\nand report" } as never })];
    await renderDot();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("fares");
    expect(screen.getByText("the tab body")).toBeTruthy();
    const goal = screen.getByRole("button", { name: /Watch fares/ });
    expect(goal.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(goal);
    expect(goal.getAttribute("aria-expanded")).toBe("true");
  });

  it("says the Dot cannot be loaded when the control plane has no such Dot", async () => {
    plane.dots = [];
    render(
      <EventStreamProvider>
        <AttentionProvider>
          <DotShell dotId="nope">
            <p>body</p>
          </DotShell>
        </AttentionProvider>
      </EventStreamProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load this Dot");
  });

  it("shows what the Dot is doing from the agent's events, and only this Dot's", async () => {
    plane.dots = [dotRecord("d1"), dotRecord("d2")];
    await renderDot();
    expect(screen.getByText("Idle")).toBeTruthy();
    act(() => plane.push("d2", "agent.state", { state: "EXECUTING" }));
    act(() => plane.push("d1", "agent.state", { state: "THINKING" }));
    await waitFor(() => expect(screen.getByText("Thinking...")).toBeTruthy());
    expect(screen.queryByText("Running a tool...")).toBeNull();
    expect(screen.getByRole("img", { name: "Working" })).toBeTruthy();
  });

  it("shows a Dot that waits for the person, with a link to its approvals in the Inbox", async () => {
    plane.dots = [dotRecord("d1", { status: "WAITING_APPROVAL" })];
    plane.approvals = [approvalRecord("a1", "d1")];
    await renderDot();
    const pill = await screen.findByRole("link", { name: /Waiting for you/ });
    expect(pill.getAttribute("href")).toBe("/inbox?dot=d1");
    expect(screen.getByRole("img", { name: "Waiting for you" })).toBeTruthy();
  });

  it("shows what the Dot spent today, and refreshes it when a reply or a task ends", async () => {
    plane.dots = [dotRecord("d1")];
    plane.spentUsd = 0.4249;
    await renderDot();
    expect(await screen.findByText("$0.42")).toBeTruthy();
    expect(plane.requests).toContain("GET /api/dots/d1/usage");
    plane.spentUsd = 1.5;
    act(() => plane.push("d1", "task.completed", { task_id: "t1", summary: "ok", spent_usd: 1.08 }));
    expect(await screen.findByText("$1.50")).toBeTruthy();
  });

  it("explains an error with the Dot's reason and the computer's, and points to the settings", async () => {
    plane.dots = [dotRecord("d1", { status: "ERROR", error: "the start failed", computer_state: "ERROR" })];
    plane.computerLastError = "qemu exited with 1";
    await renderDot();
    const title = await screen.findByText("This Dot is in an error state");
    const banner = title.closest('[data-slot="alert"]') as HTMLElement;
    expect(within(banner).getByText("the start failed")).toBeTruthy();
    await waitFor(() => expect(within(banner).getByText("Computer: qemu exited with 1")).toBeTruthy());
    expect(within(banner).getByRole("link", { name: "Open settings" }).getAttribute("href")).toBe("/dots/d1/settings");
    expect(screen.getByRole("img", { name: "Needs attention: error" })).toBeTruthy();
  });

  it("offers a Reboot in the error banner when the computer is up", async () => {
    plane.dots = [dotRecord("d1", { status: "ERROR", error: "the agent died", computer_state: "RUNNING" })];
    await renderDot();
    const banner = (await screen.findByText("This Dot is in an error state")).closest('[data-slot="alert"]') as HTMLElement;
    expect(within(banner).queryByRole("button", { name: "Start the computer" })).toBeNull();
    await userEvent.click(within(banner).getByRole("button", { name: "Reboot" }));
    await waitFor(() => expect(plane.requests).toContain("POST /api/dots/d1/computer/reboot"));
  });

  it("offers to start the computer instead when the computer itself is in error, as the host reboots only a running one", async () => {
    plane.dots = [dotRecord("d1", { status: "ERROR", error: "the start failed", computer_state: "ERROR" })];
    await renderDot();
    const banner = (await screen.findByText("This Dot is in an error state")).closest('[data-slot="alert"]') as HTMLElement;
    expect(within(banner).queryByRole("button", { name: "Reboot" })).toBeNull();
    await userEvent.click(within(banner).getByRole("button", { name: "Start the computer" }));
    await waitFor(() => expect(plane.requests).toContain("POST /api/dots/d1/computer/start"));
  });

  it("offers no power action in the banner of a Dot that has no computer", async () => {
    plane.dots = [dotRecord("d1", { status: "ERROR", error: "never created", computer_state: null })];
    await renderDot();
    const banner = (await screen.findByText("This Dot is in an error state")).closest('[data-slot="alert"]') as HTMLElement;
    expect(within(banner).queryByRole("button")).toBeNull();
    expect(within(banner).getByRole("link", { name: "Open settings" })).toBeTruthy();
  });

  it("does not ask the computer for an error that is not there", async () => {
    plane.dots = [dotRecord("d1")];
    await renderDot();
    expect(plane.requests).not.toContain("GET /api/dots/d1/computer");
    expect(screen.queryByText("This Dot is in an error state")).toBeNull();
  });

  it("says the agent was restarted in the middle of work, until the person dismisses it", async () => {
    plane.dots = [dotRecord("d1")];
    await renderDot();
    act(() => plane.push("d1", "agent.state", { state: "EXECUTING" }));
    act(() => plane.push("d1", "agent.started"));
    expect(await screen.findByText("Interrupted, restarted")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Interrupted, restarted")).toBeNull();
  });
});

describe("the tab bar", () => {
  it("links every tab that exists and marks the open one", async () => {
    plane.dots = [dotRecord("d1"), dotRecord("d2")];
    plane.approvals = [approvalRecord("a1", "d1"), approvalRecord("a2", "d2"), approvalRecord("a3", "d2")];
    pathname = "/dots/d1/tasks";
    await renderDot();
    const tabs = within(screen.getByRole("navigation", { name: "Dot sections" }));
    expect(tabs.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(
      ["chat", "tasks", "computer", "memory", "channels", "activity", "settings"].map((slug) => "/dots/d1/" + slug),
    );
    expect(tabs.getByRole("link", { name: "Tasks" }).getAttribute("aria-current")).toBe("page");
    expect(tabs.getByRole("link", { name: "Chat" }).getAttribute("aria-current")).toBeNull();
    // Approvals are the Inbox's, filtered to the Dot: the tab bar has no Approvals tab.
    expect(tabs.queryByRole("link", { name: /Approvals/ })).toBeNull();
  });

  it("marks the Channels tab while a channel of the Dot needs linking again, and only then", async () => {
    plane.dots = [dotRecord("d1"), dotRecord("d2")];
    plane.channels = { d1: [channelRecord("telegram", { status: "needs_relink" })], d2: [channelRecord("telegram")] };
    await renderDot();
    const tabs = within(screen.getByRole("navigation", { name: "Dot sections" }));
    expect(await tabs.findByLabelText("needs linking again")).toBeTruthy();
    expect(within(tabs.getByRole("link", { name: /Channels/ })).getByLabelText("needs linking again")).toBeTruthy();
    expect(tabs.getAllByLabelText("needs linking again")).toHaveLength(1);
    cleanup();

    await renderDot("d2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(screen.getByRole("navigation", { name: "Dot sections" })).queryByLabelText("needs linking again")).toBeNull();
  });
});

describe("the power menu", () => {
  async function openMenu() {
    await userEvent.click(await screen.findByRole("button", { name: /^Computer: .*Power menu$/ }));
    return screen.findByRole("menu");
  }

  it("offers only what the computer's state allows", async () => {
    plane.dots = [dotRecord("d1", { computer_state: "RUNNING" })];
    await renderDot();
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Start" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: "Reboot" }).getAttribute("aria-disabled")).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Stop" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("starts a stopped computer and says so", async () => {
    plane.dots = [dotRecord("d1", { computer_state: "STOPPED" })];
    await renderDot();
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Stop" }).getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Start" }));
    await waitFor(() => expect(plane.requests).toContain("POST /api/dots/d1/computer/start"));
    expect(await screen.findByText("Starting the computer")).toBeTruthy();
  });

  it("asks before it stops a computer that is running a task, and does nothing when the person says no", async () => {
    plane.dots = [dotRecord("d1", { status: "RUNNING" })];
    await renderDot();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Stop" }));
    expect(confirm).toHaveBeenCalledWith("A task is running. Stop the computer anyway?");
    expect(plane.requests).not.toContain("POST /api/dots/d1/computer/stop");

    confirm.mockReturnValue(true);
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Stop" }));
    await waitFor(() => expect(plane.requests).toContain("POST /api/dots/d1/computer/stop"));
  });

  it("reboots an idle computer without asking", async () => {
    plane.dots = [dotRecord("d1", { status: "READY" })];
    await renderDot();
    const confirm = vi.spyOn(window, "confirm");
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Reboot" }));
    await waitFor(() => expect(plane.requests).toContain("POST /api/dots/d1/computer/reboot"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows the control plane's refusal as a message", async () => {
    plane.dots = [dotRecord("d1", { computer_state: "RUNNING" })];
    plane.failComputerAction = 409;
    await renderDot();
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Reboot" }));
    expect(await screen.findByText("the computer refused (409)")).toBeTruthy();
  });

  it("is disabled, and says why, for a Dot that has no computer yet", async () => {
    plane.dots = [dotRecord("d1", { status: "CREATING", computer_state: null })];
    await renderDot();
    expect(screen.getByRole("button", { name: "No computer yet" }).hasAttribute("disabled")).toBe(true);
  });
});
