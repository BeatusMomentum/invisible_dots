// @vitest-environment jsdom
import type { BrowserIdentity } from "@invisible-dots/shared/browser";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerPanel } from "../src/components/computer/ComputerPanel";
import { frameAgeSeconds, ScreenView } from "../src/components/computer/screen-view";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { ApiError } from "../src/lib/api";
import { computerIsUp, frameProblem } from "../src/lib/computer";
import { stubObjectUrls } from "./support/browser";
import { dotRecord, FakeControlPlane } from "./support/control-plane";

let plane: FakeControlPlane;
let urls: ReturnType<typeof stubObjectUrls>;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1")];
  plane.install();
  urls = stubObjectUrls();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const requested = (pattern: RegExp) => plane.requests.filter((r) => pattern.test(r));

function identity(id: string, name: string, status: BrowserIdentity["status"]): BrowserIdentity {
  return { id, name, status, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, profilePath: `/home/dot/.browser/${id}` };
}

async function renderPanel(computerState: string | null = "RUNNING") {
  const view = render(
    <EventStreamProvider>
      <DotEventScope dotId="d1">
        <ComputerPanel dotId="d1" computerState={computerState} />
      </DotEventScope>
    </EventStreamProvider>,
  );
  await waitFor(() => expect(plane.streamOpen).toBe(true));
  return view;
}

describe("which computer states have a picture", () => {
  it("are the two in which the guest answers", () => {
    expect(computerIsUp("RUNNING")).toBe(true);
    expect(computerIsUp("IDLE")).toBe(true);
    for (const state of ["STOPPED", "STARTING", "PROVISIONING", "STOPPING", "ERROR", "DELETING", null]) expect(computerIsUp(state), String(state)).toBe(false);
  });
});

describe("what a failed picture means", () => {
  it("is a closed browser, a busy one, a stopped computer, or the message itself", () => {
    expect(frameProblem(new ApiError(409, "not_open", "x"))).toMatchObject({ closed: true, text: "This browser was closed." });
    expect(frameProblem(new ApiError(503, "busy", "x"))).toMatchObject({ closed: false, text: expect.stringContaining("using this browser right now") });
    expect(frameProblem(new ApiError(409, "computer_stopped", "x"))).toMatchObject({ closed: false, text: "The computer is not running." });
    expect(frameProblem(new ApiError(502, "frame_failed", "the browser did not answer"))).toEqual({ closed: false, text: "the browser did not answer" });
    expect(frameProblem(new Error("offline"))).toEqual({ closed: false, text: "offline" });
  });
});

describe("the screen view", () => {
  it("counts the age of a frame, and does not guess when it has no time", () => {
    const now = Date.parse("2026-03-10T12:00:30Z");
    expect(frameAgeSeconds("2026-03-10T12:00:00Z", now)).toBe(30);
    expect(frameAgeSeconds("2026-03-10T12:01:00Z", now)).toBe(0);
    expect(frameAgeSeconds(null, now)).toBeNull();
    expect(frameAgeSeconds("not a time", now)).toBeNull();
  });

  it("shows LIVE for a fresh frame, and the age instead once it is older than the limit", () => {
    const now = Date.parse("2026-03-10T12:00:10Z");
    const { rerender } = render(<ScreenView src="blob:x" alt="the desktop" live staleAfterSeconds={15} lastFrameAt="2026-03-10T12:00:00Z" now={now} />);
    expect(screen.getByText("LIVE")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<ScreenView src="blob:x" alt="the desktop" live staleAfterSeconds={15} lastFrameAt="2026-03-10T12:00:00Z" now={now + 10_000} />);
    expect(screen.queryByText("LIVE")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("This frame is 20s old");
    expect(screen.getByRole("img", { name: "the desktop" }).getAttribute("src")).toBe("blob:x");
  });

  it("says what it waits for when there is no frame", () => {
    render(<ScreenView alt="the desktop" placeholder="The computer did not answer" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("The computer did not answer")).toBeTruthy();
  });
});

describe("the computer panel", () => {
  it("says the computer is stopped and asks nothing of it", async () => {
    await renderPanel("STOPPED");
    expect(screen.getByText(/The computer is stopped/)).toBeTruthy();
    expect(requested(/screenshot|browser-identities/)).toEqual([]);
  });

  it("says what state the computer is in while it is on its way up", async () => {
    await renderPanel("STARTING");
    expect(screen.getByText(/The computer is starting/)).toBeTruthy();
    expect(requested(/screenshot/)).toEqual([]);
  });

  it("shows the desktop live, says the Dot has control, and reads a new picture on request", async () => {
    await renderPanel();
    const picture = await screen.findByRole("img", { name: /current picture of the desktop/ });
    expect(picture.getAttribute("src")).toBe(urls.created[0]);
    expect(screen.getByText("LIVE")).toBeTruthy();
    expect(screen.getByText("The Dot has control. You are watching.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /take over|control/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Open full size" }).getAttribute("href")).toBe(urls.created[0]);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(requested(/GET \/api\/dots\/d1\/computer\/screenshot$/)).toHaveLength(2));
    // The first picture's address is released when the second replaces it.
    await waitFor(() => expect(urls.revoked).toContain(urls.created[0]));
    expect(screen.getByRole("img", { name: /current picture of the desktop/ }).getAttribute("src")).toBe(urls.created[1]);
  });

  it("releases the picture when it goes away", async () => {
    const view = await renderPanel();
    await screen.findByRole("img", { name: /current picture of the desktop/ });
    view.unmount();
    expect(urls.revoked).toContain(urls.created[0]);
  });

  it("says why there is no picture, and shows the picture once there is one", async () => {
    plane.failPicture = { status: 502, error: "guest_unreachable", message: "the guest did not answer" };
    await renderPanel();
    expect(await screen.findByText("the guest did not answer")).toBeTruthy();
    expect(screen.queryByText("LIVE")).toBeNull();
    plane.failPicture = null;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("img", { name: /current picture of the desktop/ })).toBeTruthy();
  });

  it("offers each open browser, and not the closed ones, and shows the one picked", async () => {
    plane.identities = [identity("shop-1", "shopping", "open"), identity("res-1", "research", "available")];
    await renderPanel();
    const group = await screen.findByRole("group", { name: "What to watch" });
    await waitFor(() => expect(within(group).getByRole("button", { name: "Browser: shopping" })).toBeTruthy());
    expect(within(group).queryByRole("button", { name: "Browser: research" })).toBeNull();
    expect(within(group).getByRole("button", { name: "Desktop" }).getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(within(group).getByRole("button", { name: "Browser: shopping" }));
    expect(await screen.findByRole("img", { name: /current picture of the browser "shopping"/ })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Browser: shopping" }).getAttribute("aria-pressed")).toBe("true");
    expect(requested(/GET \/api\/dots\/d1\/browser-identities\/shop-1\/frame$/).length).toBeGreaterThan(0);
  });

  it("goes back to the desktop when the browser it shows is closed, and tells nothing false meanwhile", async () => {
    plane.identities = [identity("shop-1", "shopping", "open")];
    await renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Browser: shopping" }));
    await screen.findByRole("img", { name: /browser "shopping"/ });

    plane.identities = [identity("shop-1", "shopping", "available")];
    act(() => plane.push("d1", "browser.identity.closed", { identity_id: "shop-1", name: "shopping" }));
    expect(await screen.findByRole("img", { name: /current picture of the desktop/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browser: shopping" })).toBeNull();
    expect(screen.getByRole("button", { name: "Desktop" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the last picture and says why when a call of the Dot holds the browser", async () => {
    plane.identities = [identity("shop-1", "shopping", "open")];
    await renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Browser: shopping" }));
    await screen.findByRole("img", { name: /browser "shopping"/ });
    plane.failPicture = { status: 503, error: "busy", message: "busy" };
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/using this browser right now/)).toBeTruthy();
    expect(screen.getByRole("img", { name: /browser "shopping"/ })).toBeTruthy();
    expect(screen.queryByText("LIVE")).toBeNull();
  });

  it("lists browsers again when one opens", async () => {
    await renderPanel();
    await screen.findByRole("img", { name: /desktop/ });
    expect(screen.queryByRole("button", { name: /^Browser:/ })).toBeNull();
    plane.identities = [identity("shop-1", "shopping", "open")];
    act(() => plane.push("d1", "browser.identity.launched", { identity_id: "shop-1", name: "shopping" }));
    expect(await screen.findByRole("button", { name: "Browser: shopping" })).toBeTruthy();
  });
});
