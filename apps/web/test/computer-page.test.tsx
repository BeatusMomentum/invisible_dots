// @vitest-environment jsdom
import type { BrowserIdentity } from "@invisible-dots/shared/browser";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerView } from "../src/components/computer/ComputerView";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { Toaster } from "../src/components/ui/sonner";
import { BROWSER_ACTIVITY_EVENT_TYPES, BROWSER_ACTIVITY_TOOLS, BROWSER_ACTIVITY_WINDOW } from "../src/lib/browser-activity";
import { parseComputerQuery } from "../src/lib/computer-view";
import { stubMatchMedia, stubObjectUrls } from "./support/browser";
import { dotRecord, FakeControlPlane } from "./support/control-plane";

vi.mock("next/navigation", () => ({ usePathname: () => "/dots/d1/computer", useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;
let urls: ReturnType<typeof stubObjectUrls>;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" })];
  plane.install();
  stubMatchMedia();
  urls = stubObjectUrls();
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const requested = (pattern: RegExp) => plane.requests.filter((r) => pattern.test(r));

function identity(id: string, name: string, status: BrowserIdentity["status"], change: Partial<BrowserIdentity> = {}): BrowserIdentity {
  return { id, name, status, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, profilePath: `/home/dot/browsers/${id}`, ...change };
}

/** The Computer page as the Dot's layout puts it: inside the Dot's shell, with the view the address names. */
async function renderComputer(params: Record<string, string> = {}) {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId="d1">
          <DotShell dotId="d1">
            <ComputerView query={parseComputerQuery(params)} />
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
      <Toaster />
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 1, hidden: true });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
}

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

describe("the views of the Computer page", () => {
  it("links each view to its own address and marks the open one", async () => {
    await renderComputer({ view: "browser" });
    const nav = within(screen.getByRole("navigation", { name: "Computer views" }));
    expect(nav.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Screen", "/dots/d1/computer"],
      ["Browser", "/dots/d1/computer?view=browser"],
      ["Files", "/dots/d1/computer?view=files"],
      ["Usage", "/dots/d1/computer?view=usage"],
    ]);
    expect(nav.getByRole("link", { name: "Browser" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getByRole("link", { name: "Screen" }).getAttribute("aria-current")).toBeNull();
  });

  it("asks nothing of a stopped computer for the screen, the browsers or the files, and offers to start it", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STOPPED" })];
    for (const [view, what] of [
      ["screen", "Start the computer to see its screen"],
      ["browser", "Start the computer to see its browsers"],
      ["files", "Start the computer to see its files"],
    ] as const) {
      await renderComputer({ view });
      expect((await screen.findByRole("status")).textContent).toContain(what);
      cleanup();
    }
    expect(requested(/screenshot|browser-identities|\/files/)).toEqual([]);

    await renderComputer({ view: "files" });
    await userEvent.click(await screen.findByRole("button", { name: "Start the computer" }));
    await waitFor(() => expect(requested(/POST \/api\/dots\/d1\/computer\/start$/)).toHaveLength(1));
  });

  it("explains a computer that is starting, and offers no button for it", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STARTING" })];
    await renderComputer({ view: "screen" });
    expect((await screen.findByRole("status")).textContent).toContain("starting");
    expect(screen.queryByRole("button", { name: "Start the computer" })).toBeNull();
  });

  it("explains a stopped computer from the answer of a route too, when the page had not heard yet", async () => {
    plane.failIdentities = { status: 409, error: "computer_stopped", message: "the computer is STOPPED" };
    await renderComputer({ view: "browser" });
    expect((await screen.findByRole("status")).textContent).toContain("Start the computer to see its browsers");
  });
});

describe("the screen", () => {
  it("shows the desktop as a live picture and says that the Dot has control", async () => {
    await renderComputer();
    const picture = await screen.findByRole("img", { name: /current picture of the desktop/ });
    expect(picture.getAttribute("src")).toMatch(/^blob:/);
    expect(screen.getByText("The Dot has control. You are watching.")).toBeTruthy();
    expect(screen.getByText("LIVE")).toBeTruthy();
    expect(requested(/GET \/api\/dots\/d1\/computer\/screenshot$/).length).toBeGreaterThanOrEqual(1);
  });
});

describe("the browsers", () => {
  it("lists them open first, with the state in words, the proxy without its password and the time of last use", async () => {
    plane.identities = [
      identity("closed-1", "Closed one", "available", { proxy: "http://user:hunter2@proxy.example:8080", lastUsedAt: secondsAgo(3 * 3600) }),
      identity("open-1", "Open one", "open", { lastUsedAt: secondsAgo(120) }),
    ];
    await renderComputer({ view: "browser" });
    const cards = (await screen.findAllByRole("article")).map((card) => card.getAttribute("aria-label"));
    expect(cards).toEqual(["Open one", "Closed one"]);

    const open = screen.getByRole("article", { name: "Open one" });
    expect(within(open).getByText("Open")).toBeTruthy();
    expect(within(open).getByText("2m ago")).toBeTruthy();
    expect(within(open).getByText("none")).toBeTruthy();

    const closed = screen.getByRole("article", { name: "Closed one" });
    expect(within(closed).getByText("Closed")).toBeTruthy();
    expect(within(closed).getByText("3h ago")).toBeTruthy();
    // The control plane replaces the password before it answers; whatever reached the page, it is replaced again by the
    // same rule (the shared package's, the engine's own), which keeps the user.
    expect(within(closed).getByText("http://user:***@proxy.example:8080")).toBeTruthy();
    expect(within(closed).queryByText(/hunter2/)).toBeNull();
  });

  it("explains the limits, and the empty case", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: { goal: "g", browser: { identities: { managed_by_dot: true, max_identities: 4, max_open: 2 } } } as never })];
    await renderComputer({ view: "browser" });
    expect(await screen.findByText("No browsers yet")).toBeTruthy();
    expect(screen.getByText(/The Dot makes one when it needs to browse/)).toBeTruthy();
    cleanup();

    plane.identities = [identity("a", "A", "open"), identity("b", "B", "available")];
    plane.dots = [dotRecord("d1", { name: "fares", config: { goal: "g", browser: { identities: { managed_by_dot: false, max_identities: 4, max_open: 2 } } } as never })];
    await renderComputer({ view: "browser" });
    expect((await screen.findByLabelText("Limits")).textContent).toContain("2 of 4 browsers, 1 of 2 open at once");
    expect(screen.getByText(/The Dot cannot create or delete browsers itself/)).toBeTruthy();
  });

  it("shows the window of the first open browser at once, and another when it is picked", async () => {
    plane.identities = [identity("a", "Alpha", "open"), identity("b", "Bravo", "open")];
    await renderComputer({ view: "browser" });
    expect(await screen.findByRole("img", { name: /browser "Alpha"/ })).toBeTruthy();
    expect(requested(/GET \/api\/dots\/d1\/browser-identities\/a\/frame$/).length).toBeGreaterThanOrEqual(1);
    expect(within(screen.getByRole("article", { name: "Alpha" })).queryByRole("button", { name: /^Watch/ })).toBeNull();

    await userEvent.click(within(screen.getByRole("article", { name: "Bravo" })).getByRole("button", { name: /^Watch/ }));
    expect(await screen.findByRole("img", { name: /browser "Bravo"/ })).toBeTruthy();
    expect(requested(/GET \/api\/dots\/d1\/browser-identities\/b\/frame$/).length).toBeGreaterThanOrEqual(1);
  });

  it("shows the page the Dot last opened in the window's bar, from the log, and none when it opened none", async () => {
    plane.identities = [identity("a", "Alpha", "open")];
    await renderComputer({ view: "browser" });
    const stage = await screen.findByRole("region", { name: "Window of Alpha" });
    expect(within(stage).getByText("The Dot has not opened a page in this browser yet")).toBeTruthy();
    cleanup();

    plane.store("d1", "tool.called", { tool: "browser_navigate", permission: "browser.navigate", decision: "allow", ok: true, duration_ms: 90, target: "a: https://example.com/fares" }, secondsAgo(600));
    plane.requests.length = 0;
    await renderComputer({ view: "browser" });
    const next = await screen.findByRole("region", { name: "Window of Alpha" });
    await waitFor(() => expect(within(next).getByLabelText("Page the Dot last opened").textContent).toBe("https://example.com/fares"));
    expect(requested(/GET \/api\/dots\/d1\/events$/)).toHaveLength(1);
  });

  it("reads only the newest window of the browser calls in one request, however long the log of the Dot's other tools is", async () => {
    plane.identities = [identity("a", "Alpha", "open")];
    plane.store("d1", "tool.called", { tool: "browser_navigate", permission: "browser.navigate", decision: "allow", ok: true, duration_ms: 90, target: "a: https://example.com/fares" }, secondsAgo(600));
    // Two and a half pages of the Dot's other calls, all newer than its page: none of them may cross the wire.
    for (let i = 0; i < 2500; i++) plane.store("d1", "tool.called", { tool: i % 2 === 0 ? "exec" : "read_file", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 1, target: "ls" }, secondsAgo(500));
    plane.store("d1", "tool.called", { tool: "browser_click", permission: "browser.act", decision: "allow", ok: true, duration_ms: 40, target: "a: #buy" }, secondsAgo(400));
    await renderComputer({ view: "browser" });
    const stage = await screen.findByRole("region", { name: "Window of Alpha" });
    await waitFor(() => expect(within(stage).getByLabelText("Page the Dot last opened").textContent).toBe("https://example.com/fares"));
    expect(plane.eventQueries).toEqual([
      { after: 0, limit: BROWSER_ACTIVITY_WINDOW, types: [...BROWSER_ACTIVITY_EVENT_TYPES], tools: [...BROWSER_ACTIVITY_TOOLS], taskId: null, order: "desc" },
    ]);
  });

  it("marks the browser the Dot is using now when a call arrives, and the mark follows only that browser", async () => {
    plane.identities = [identity("a", "Alpha", "open"), identity("b", "Bravo", "open")];
    await renderComputer({ view: "browser" });
    await screen.findByRole("article", { name: "Alpha" });
    expect(screen.queryByText("The Dot is using this now")).toBeNull();

    await act(async () => plane.push("d1", "tool.called", { tool: "browser_click", permission: "browser.act", decision: "allow", ok: true, duration_ms: 40, target: "b: #buy" }));
    await waitFor(() => expect(within(screen.getByRole("article", { name: "Bravo" })).getByText("The Dot is using this now")).toBeTruthy());
    expect(within(screen.getByRole("article", { name: "Alpha" })).queryByText("The Dot is using this now")).toBeNull();
  });

  it("does not read the log when no browser is open", async () => {
    plane.identities = [identity("a", "Alpha", "available")];
    await renderComputer({ view: "browser" });
    await screen.findByRole("article", { name: "Alpha" });
    expect(screen.getByText(/No browser is open/)).toBeTruthy();
    expect(requested(/\/events$/)).toEqual([]);
  });

  it("closes an open browser at once, and says so; the list follows the control plane", async () => {
    plane.identities = [identity("a", "Alpha", "open")];
    await renderComputer({ view: "browser" });
    const card = await screen.findByRole("article", { name: "Alpha" });
    await userEvent.click(within(card).getByRole("button", { name: /^Close/ }));
    await waitFor(() => expect(plane.closedIdentities).toEqual(["a"]));
    expect(await screen.findByText("Closed Alpha.")).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole("article", { name: "Alpha" })).getByText("Closed")).toBeTruthy());
    expect(screen.queryByRole("region", { name: "Window of Alpha" })).toBeNull();
  });

  it("asks before closing a browser the Dot is working in", async () => {
    plane.identities = [identity("a", "Alpha", "open")];
    plane.store("d1", "tool.called", { tool: "browser_click", permission: "browser.act", decision: "allow", ok: true, duration_ms: 40, target: "a: #buy" }, secondsAgo(2));
    await renderComputer({ view: "browser" });
    const card = await screen.findByRole("article", { name: "Alpha" });
    await waitFor(() => expect(within(card).getByText("The Dot is using this now")).toBeTruthy());
    await userEvent.click(within(card).getByRole("button", { name: /^Close/ }));
    const dialog = await screen.findByRole("dialog", { name: "Close Alpha?" });
    expect(plane.closedIdentities).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(plane.closedIdentities).toEqual([]);

    await userEvent.click(within(card).getByRole("button", { name: /^Close/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close browser" }));
    await waitFor(() => expect(plane.closedIdentities).toEqual(["a"]));
  });

  it("deletes a browser only after the person confirms, and keeps the question open with the reason when it fails", async () => {
    plane.identities = [identity("a", "Alpha", "available")];
    await renderComputer({ view: "browser" });
    const card = await screen.findByRole("article", { name: "Alpha" });
    await userEvent.click(within(card).getByRole("button", { name: /^Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Alpha?" });
    expect(dialog.textContent).toContain("cannot be undone");
    expect(plane.deletedIdentities).toEqual([]);

    plane.failIdentityAction = { status: 502, error: "delete_failed", message: "the profile is in use" };
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete identity" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("the profile is in use");
    expect(screen.getByRole("dialog", { name: "Delete Alpha?" })).toBeTruthy();

    plane.failIdentityAction = null;
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete identity" }));
    await waitFor(() => expect(plane.deletedIdentities).toEqual(["a"]));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Alpha" })).toBeNull());
    expect(await screen.findByText("No browsers yet")).toBeTruthy();
  });

  it("creates a browser from a name and a proxy, and lists it closed", async () => {
    await renderComputer({ view: "browser" });
    await userEvent.click(await screen.findByRole("button", { name: "New browser" }));
    const dialog = await screen.findByRole("dialog", { name: "New browser" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Shopping");
    // A proxy URL may hold a password: the field does not show what is typed.
    expect(within(dialog).getByLabelText(/^Proxy/).getAttribute("type")).toBe("password");
    await userEvent.type(within(dialog).getByLabelText(/^Proxy/), "socks5://user:pw@proxy.example:1080");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create browser" }));
    await waitFor(() => expect(plane.createdIdentities).toEqual([{ name: "Shopping", proxy: "socks5://user:pw@proxy.example:1080" }]));
    const card = await screen.findByRole("article", { name: "Shopping" });
    expect(within(card).getByText("Closed")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses a bad name or proxy before asking the control plane, in the engine's words", async () => {
    await renderComputer({ view: "browser" });
    await userEvent.click(await screen.findByRole("button", { name: "New browser" }));
    const dialog = await screen.findByRole("dialog", { name: "New browser" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create browser" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("an identity needs a non-empty name");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Shopping");
    await userEvent.type(within(dialog).getByLabelText(/^Proxy/), "ftp://host");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create browser" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("http, https, socks4 or socks5");
    expect(plane.createdIdentities).toEqual([]);
  });

  it("shows the limit the control plane reports when it refuses a browser", async () => {
    plane.failIdentityAction = { status: 409, error: "limit", message: "this Dot already has 20 browser identities" };
    await renderComputer({ view: "browser" });
    await userEvent.click(await screen.findByRole("button", { name: "New browser" }));
    const dialog = await screen.findByRole("dialog", { name: "New browser" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Shopping");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create browser" }));
    expect((await within(dialog).findByText("The browser was not created")).closest("[role=alert]")?.textContent).toContain("already has 20 browser identities");
  });

  it("follows browsers opened and closed by the Dot without a reload", async () => {
    plane.identities = [identity("a", "Alpha", "available")];
    await renderComputer({ view: "browser" });
    expect(await screen.findByText(/No browser is open/)).toBeTruthy();
    plane.identities = [identity("a", "Alpha", "open")];
    await act(async () => plane.push("d1", "browser.identity.launched", { identity_id: "a", name: "Alpha" }));
    expect(await screen.findByRole("region", { name: "Window of Alpha" })).toBeTruthy();
  });
});

describe("the files", () => {
  beforeEach(() => {
    plane.putFile("/home/dot/notes.txt", "Remember the milk.\n");
    plane.putFile("/home/dot/Zebra.md", "# zebra");
    plane.putFile("/home/dot/memory/trips/rome.md", "Rome in May");
    plane.putFile("/home/dot/shot.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    plane.putFile("/home/dot/archive.zip", Uint8Array.from([0x50, 0x4b, 3, 4]));
    plane.putFile("/home/dot/big.txt", new Uint8Array(1024 * 1024 + 1).fill(97));
    plane.putFile("/home/dot/lie.txt", Uint8Array.from([0x61, 0x00, 0x62]));
    plane.putFile("/home/dot/empty.txt", "");
  });

  it("lists the home folder, folders first, each linked to where it leads", async () => {
    await renderComputer({ view: "files" });
    const table = await screen.findByRole("table");
    const names = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]!.textContent);
    expect(names).toEqual(["memory (folder)", "archive.zip", "big.txt", "empty.txt", "lie.txt", "notes.txt", "shot.png", "Zebra.md"]);
    expect(within(table).getByRole("link", { name: /^memory\s*\(folder\)$/ }).getAttribute("href")).toBe("/dots/d1/computer?view=files&path=%2Fhome%2Fdot%2Fmemory");
    expect(within(table).getByRole("link", { name: "notes.txt" }).getAttribute("href")).toBe("/dots/d1/computer?view=files&path=%2Fhome%2Fdot&file=notes.txt");
    expect(within(table).getByText("19 B")).toBeTruthy();
  });

  it("walks into a folder, with a path back to each folder above it", async () => {
    await renderComputer({ view: "files", path: "/home/dot/memory/trips" });
    expect(await screen.findByRole("link", { name: "rome.md" })).toBeTruthy();
    const crumbs = within(screen.getByRole("navigation", { name: "Folder" }));
    expect(crumbs.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Home", "/dots/d1/computer?view=files&path=%2Fhome%2Fdot"],
      ["memory", "/dots/d1/computer?view=files&path=%2Fhome%2Fdot%2Fmemory"],
    ]);
    expect(crumbs.getByText("trips").getAttribute("aria-current")).toBe("page");
    // A relative address is read the way the control plane reads it, and the page shows the path it answered with.
    cleanup();
    await renderComputer({ view: "files", path: "memory" });
    expect(await screen.findByRole("link", { name: /^trips\s*\(folder\)$/ })).toBeTruthy();
  });

  it("says an empty folder is empty", async () => {
    plane.files.clear();
    await renderComputer({ view: "files" });
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
  });

  it("shows a text file's text, as text", async () => {
    await renderComputer({ view: "files", file: "notes.txt" });
    const preview = await screen.findByRole("region", { name: "File notes.txt" });
    await waitFor(() => expect(within(preview).getByLabelText("Contents of notes.txt").textContent).toBe("Remember the milk.\n"));
    expect(requested(/GET \/api\/dots\/d1\/files$/)).toHaveLength(1);
  });

  it("never draws markup the Dot wrote: html is shown as its own text", async () => {
    plane.putFile("/home/dot/page.html", '<img src=x onerror="alert(1)"><b>bold</b>');
    await renderComputer({ view: "files", file: "page.html" });
    const preview = await screen.findByRole("region", { name: "File page.html" });
    await waitFor(() => expect(within(preview).getByLabelText("Contents of page.html").textContent).toBe('<img src=x onerror="alert(1)"><b>bold</b>'));
    expect(preview.querySelector("img, b")).toBeNull();
  });

  it("draws an image from the bytes, and lets go of the address when it is closed", async () => {
    await renderComputer({ view: "files", file: "shot.png" });
    const preview = await screen.findByRole("region", { name: "File shot.png" });
    const picture = await within(preview).findByRole("img", { name: "The picture shot.png" });
    expect(picture.getAttribute("src")).toMatch(/^blob:/);
    cleanup();
    expect(urls.revoked).toContain(picture.getAttribute("src"));
  });

  it("offers a download alone for a kind it does not show, and does not read it", async () => {
    await renderComputer({ view: "files", file: "archive.zip" });
    const preview = await screen.findByRole("region", { name: "File archive.zip" });
    expect(within(preview).getByText(/This kind of file is not shown here/)).toBeTruthy();
    expect(requested(/GET \/api\/dots\/d1\/files$/)).toEqual([]);
  });

  it("does not read a file too big for a glance, and says how big it is", async () => {
    await renderComputer({ view: "files", file: "big.txt" });
    const preview = await screen.findByRole("region", { name: "File big.txt" });
    expect(within(preview).getByText(/too big to show here \(1\.0 MiB\)/)).toBeTruthy();
    expect(requested(/GET \/api\/dots\/d1\/files$/)).toEqual([]);
  });

  it("does not show a file named text that holds bytes of something else", async () => {
    await renderComputer({ view: "files", file: "lie.txt" });
    const preview = await screen.findByRole("region", { name: "File lie.txt" });
    expect(await within(preview).findByText(/This file is not text/)).toBeTruthy();
  });

  it("says a file is empty", async () => {
    await renderComputer({ view: "files", file: "empty.txt" });
    const preview = await screen.findByRole("region", { name: "File empty.txt" });
    expect(await within(preview).findByText("The file is empty.")).toBeTruthy();
  });

  it("saves a file by reading it through the API and handing the bytes to the browser", async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    });
    await renderComputer({ view: "files", file: "archive.zip" });
    const preview = await screen.findByRole("region", { name: "File archive.zip" });
    await userEvent.click(within(preview).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0]!.download).toBe("archive.zip");
    expect(clicks[0]!.href).toMatch(/^blob:/);
    expect(requested(/GET \/api\/dots\/d1\/files$/)).toHaveLength(1);
  });

  it("says a file that is not in the folder (any more) is not, and a folder likewise", async () => {
    await renderComputer({ view: "files", file: "gone.txt" });
    expect(await screen.findByText(/There is no file called gone.txt in this folder/)).toBeTruthy();
    cleanup();

    await renderComputer({ view: "files", path: "/home/dot/nowhere" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This folder does not exist (any more).");
    expect(within(alert).getByRole("link", { name: "Go to the home folder" }).getAttribute("href")).toBe("/dots/d1/computer?view=files");
  });

  it("says why a path leads nowhere the page may go, and shows any other failure as it was said", async () => {
    plane.failFiles = { status: 403, error: "outside_home", message: "the path leads outside /home/dot" };
    await renderComputer({ view: "files" });
    expect((await screen.findByRole("alert")).textContent).toContain("outside the Dot's home folder");
    cleanup();

    plane.failFiles = { status: 500, error: "io_error", message: "the disk said no" };
    await renderComputer({ view: "files" });
    expect((await screen.findByText("Could not list the folder")).closest("[role=alert]")?.textContent).toContain("the disk said no");
  });

  it("reads the folder again when the Dot writes a note", async () => {
    await renderComputer({ view: "files" });
    await screen.findByRole("table");
    const before = requested(/GET \/api\/dots\/d1\/files\/list$/).length;
    plane.putFile("/home/dot/new.txt", "new");
    await act(async () => plane.push("d1", "memory.written", { key: "new.txt" }));
    expect(await screen.findByRole("link", { name: "new.txt" })).toBeTruthy();
    expect(requested(/GET \/api\/dots\/d1\/files\/list$/).length).toBeGreaterThan(before);
  });
});

describe("the usage", () => {
  const system = { hostname: "dot-1", uptime_s: 3700, cpus: 2, mem_total_bytes: 4 * 1024 ** 3, mem_available_bytes: 1 * 1024 ** 3, disk_total_bytes: 40 * 1024 ** 3, disk_free_bytes: 36 * 1024 ** 3 };

  it("compares what the computer was given with what it uses, and names the images it started from", async () => {
    plane.system = system;
    plane.dots = [dotRecord("d1", { name: "fares", config: { goal: "g", computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" } } as never })];
    await renderComputer({ view: "usage" });
    const given = await screen.findByRole("region", { name: "Given to the computer" });
    expect(within(given).getByText("4gb")).toBeTruthy();
    expect(within(given).getByText("15m")).toBeTruthy();
    const live = screen.getByRole("region", { name: "In use now" });
    expect(within(live).getByText("1h 1m")).toBeTruthy();
    const memory = within(live).getByRole("meter", { name: "Memory used" });
    expect(memory.getAttribute("aria-valuenow")).toBe("75");
    expect(within(live).getByRole("meter", { name: "Disk used" }).getAttribute("aria-valuenow")).toBe("10");
    const images = screen.getByRole("region", { name: "Images" });
    expect(within(images).getByText("golden-1.qcow2")).toBeTruthy();
    expect(within(images).getByText("runtime-1.iso")).toBeTruthy();
  });

  it("says a computer that did not report is not reporting, rather than showing zeros", async () => {
    plane.system = null;
    await renderComputer({ view: "usage" });
    expect(await screen.findByText("The computer did not report its usage.")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows what the model cost today and in total", async () => {
    plane.spentUsd = 0.42;
    plane.spentTotalUsd = 3.5;
    await renderComputer({ view: "usage" });
    const spend = await screen.findByRole("region", { name: "Model spend" });
    await waitFor(() => expect(within(spend).getByText("$0.42")).toBeTruthy());
    expect(within(spend).getByText("$3.50")).toBeTruthy();
    expect(requested(/GET \/api\/dots\/d1\/usage$/).length).toBeGreaterThanOrEqual(2);
  });

  it("reads while the computer is off, and says why the last start failed", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "ERROR" })];
    plane.computerLastError = "qemu exited with 1";
    plane.ready = false;
    await renderComputer({ view: "usage" });
    expect((await screen.findByText("The last start or stop failed")).closest("[role=alert]")?.textContent).toContain("qemu exited with 1");
    expect(within(screen.getByRole("region", { name: "Images" })).getByText("Not yet")).toBeTruthy();
    expect(screen.getByText("What it uses is shown while the computer runs.")).toBeTruthy();
  });

  it("offers only the power actions the state allows, and sends the one pressed", async () => {
    await renderComputer({ view: "usage" });
    expect((await screen.findByRole("button", { name: "Start" })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reboot" }).hasAttribute("disabled")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Reboot" }));
    await waitFor(() => expect(requested(/POST \/api\/dots\/d1\/computer\/reboot$/)).toHaveLength(1));
    expect(await screen.findByText("Rebooting the computer")).toBeTruthy();
  });

  it("says in its own card when the next automation is due, and when the person's stop has paused them", async () => {
    plane.nextAutomationAt = new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString();
    await renderComputer({ view: "usage" });
    const card = await screen.findByRole("region", { name: "Automations" });
    expect((await within(card).findByRole("status")).textContent).toMatch(/^Next automation: .*\(in 2h\)\.$/);

    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STOPPED" })];
    plane.computerStopReason = "user";
    cleanup();
    await renderComputer({ view: "usage" });
    const paused = await within(await screen.findByRole("region", { name: "Automations" })).findByRole("status");
    expect(paused.textContent).toMatch(/^Paused: you stopped this computer, so its automations do not run/);
    expect(paused.getAttribute("data-paused")).toBe("true");
  });

  it("follows the next run the engine reports", async () => {
    await renderComputer({ view: "usage" });
    const card = await screen.findByRole("region", { name: "Automations" });
    expect((await within(card).findByRole("status")).textContent).toBe("No automation is due.");
    plane.nextAutomationAt = new Date(Date.now() + 3 * 3_600_000 + 60_000).toISOString();
    act(() => plane.push("d1", "automation.next_run", { next_run_at_ms: Date.parse(plane.nextAutomationAt!) }));
    await waitFor(() => expect(within(card).getByRole("status").textContent).toMatch(/\(in 3h\)\.$/));
  });

  it("does not stop the computer under a running task without asking", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", status: "RUNNING" as never })];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderComputer({ view: "usage" });
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(requested(/computer\/stop$/)).toEqual([]);
  });
});
