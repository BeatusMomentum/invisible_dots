// @vitest-environment jsdom
import { MAX_HOST_FILE_BYTES } from "@invisible-dots/shared/browser";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerView } from "../src/components/computer/ComputerView";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { Toaster } from "../src/components/ui/sonner";
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
  it("links each view to its own address and marks the open one: the browsers have no view, an open one is a window of the screen", async () => {
    await renderComputer({ view: "files" });
    const nav = within(screen.getByRole("navigation", { name: "Computer views" }));
    expect(nav.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Screen", "/dots/d1/computer"],
      ["Files", "/dots/d1/computer?view=files"],
      ["Usage", "/dots/d1/computer?view=usage"],
    ]);
    expect(nav.getByRole("link", { name: "Files" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getByRole("link", { name: "Screen" }).getAttribute("aria-current")).toBeNull();
  });

  it("asks nothing of a stopped computer for the screen or the files, and offers to start it", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STOPPED" })];
    for (const [view, what] of [
      ["screen", "Start the computer to see its screen"],
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
    plane.failFiles = { status: 409, error: "computer_stopped", message: "the computer is STOPPED" };
    await renderComputer({ view: "files" });
    expect((await screen.findByRole("status")).textContent).toContain("Start the computer to see its files");
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

  it("does not offer to download a file the control plane would refuse, and says why", async () => {
    plane.putFile("/home/dot/huge.bin", new Uint8Array(MAX_HOST_FILE_BYTES + 1));
    await renderComputer({ view: "files", file: "huge.bin" });
    const preview = await screen.findByRole("region", { name: "File huge.bin" });
    expect(within(preview).getByText(/too big to be handed out/)).toBeTruthy();
    expect(within(preview).queryByRole("button", { name: "Download" })).toBeNull();
    expect(requested(/GET \/api\/dots\/d1\/files$/)).toEqual([]);
    // One at the limit is handed out.
    cleanup();
    plane.putFile("/home/dot/limit.bin", new Uint8Array(MAX_HOST_FILE_BYTES));
    await renderComputer({ view: "files", file: "limit.bin" });
    expect(within(await screen.findByRole("region", { name: "File limit.bin" })).getByRole("button", { name: "Download" })).toBeTruthy();
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

  it("reads the folder again when the Dot ends a turn, which may have written files", async () => {
    await renderComputer({ view: "files" });
    await screen.findByRole("table");
    const before = requested(/GET \/api\/dots\/d1\/files\/list$/).length;
    plane.putFile("/home/dot/new.txt", "new");
    await act(async () => plane.push("d1", "message.assistant", { text: "done" }));
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
    // The money is in dollars, and the page says that no token count is kept (design 1.9): the engine reports cost only.
    expect(within(spend).getByText(/in US dollars as OpenRouter priced them\. Tokens are not reported, only the cost\./)).toBeTruthy();
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
