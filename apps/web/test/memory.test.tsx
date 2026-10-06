// @vitest-environment jsdom
import type { Automation, DotConfig } from "@invisible-dots/shared/browser";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { MemoryView } from "../src/components/memory/MemoryView";
import { AttentionProvider } from "../src/components/shell/attention";
import { Toaster } from "../src/components/ui/sonner";
import { MAX_NOTE_FOLDERS } from "../src/lib/notes";
import { parseMemoryQuery } from "../src/lib/memory-view";
import { stubMatchMedia, stubObjectUrls, stubResizeObserver } from "./support/browser";
import { dotRecord, FakeControlPlane } from "./support/control-plane";

vi.mock("next/navigation", () => ({ usePathname: () => "/dots/d1/memory", useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" })];
  plane.install();
  stubMatchMedia();
  stubResizeObserver();
  stubObjectUrls();
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const requested = (pattern: RegExp) => plane.requests.filter((r) => pattern.test(r));

/** The Memory page as the Dot's layout puts it: inside the Dot's shell, with the view the address names. */
async function renderMemory(params: Record<string, string> = {}) {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId="d1">
          <DotShell dotId="d1">
            <MemoryView query={parseMemoryQuery(params)} />
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
      <Toaster />
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 1, hidden: true });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

describe("the views of the Memory page", () => {
  it("links each view to its own address and marks the open one", async () => {
    await renderMemory({ view: "automations" });
    const nav = within(screen.getByRole("navigation", { name: "Memory views" }));
    expect(nav.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Notes", "/dots/d1/memory"],
      ["Automations", "/dots/d1/memory?view=automations"],
    ]);
    expect(nav.getByRole("link", { name: "Automations" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getByRole("link", { name: "Notes" }).getAttribute("aria-current")).toBeNull();
  });

  it("asks nothing of a stopped computer, says so for each view, and offers to start it", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STOPPED" })];
    for (const [view, what] of [
      ["notes", "Start the computer to read its notes"],
      ["automations", "Start the computer to see its automations"],
    ] as const) {
      await renderMemory({ view });
      expect(await screen.findByText(what)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Start the computer" })).toBeTruthy();
      cleanup();
    }
    expect(requested(/files|automations/)).toEqual([]);
  });

  it("says so too when the computer stopped after the page asked", async () => {
    plane.automations = null;
    await renderMemory({ view: "automations" });
    expect(await screen.findByText("Start the computer to see its automations")).toBeTruthy();
  });
});

describe("the notes", () => {
  it("lists what the Dot wrote, newest first, with the folder a note is in and when it was written", async () => {
    plane.putFile("/home/dot/memory/fares.md", "Cheapest in May.", hoursAgo(5));
    plane.putFile("/home/dot/memory/trips/rome.md", "Rome in May", hoursAgo(1));
    plane.putFile("/home/dot/notes.txt", "not a note: it is outside the memory folder");
    await renderMemory();
    const list = await screen.findByRole("list", { name: "Notes" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toBe("trips/rome.mdWritten 1h ago · 11 B");
    expect(rows[1]!.textContent).toBe("fares.mdWritten 5h ago · 16 B");
    expect(within(list).getByRole("link", { name: /rome\.md/ }).getAttribute("href")).toBe("/dots/d1/memory?note=trips%2Frome.md");
    expect(screen.getByText("Pick a note to read it.")).toBeTruthy();
    expect(screen.queryByText(/notes\.txt/)).toBeNull();
  });

  it("says the Dot has written none while the memory folder is not there", async () => {
    await renderMemory();
    expect(await screen.findByText(/has not written a note yet/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Notes" })).toBeNull();
  });

  it("searches by name, whatever the case, and says when nothing matches", async () => {
    plane.putFile("/home/dot/memory/fares.md", "a");
    plane.putFile("/home/dot/memory/trips/Rome.md", "b");
    await renderMemory();
    await screen.findByRole("list", { name: "Notes" });
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search notes by name" }), "ROME");
    expect(within(screen.getByRole("list", { name: "Notes" })).getAllByRole("listitem")).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "nowhere");
    expect(screen.getByRole("status").textContent).toBe('No note has "nowhere" in its name.');
    expect(screen.queryByRole("list", { name: "Notes" })).toBeNull();
  });

  it("reads the open note as Markdown, never as raw markup, and marks it as the current one", async () => {
    plane.putFile("/home/dot/memory/trips/rome.md", "# Rome\n\nBook **the** hotel.\n\n<script>alert(1)</script>\n\n[map](https://example.com/rome)");
    await renderMemory({ note: "trips/rome.md" });
    const reader = await screen.findByRole("region", { name: "File rome.md" });
    expect(await within(reader).findByRole("heading", { name: "Rome" })).toBeTruthy();
    expect(reader.querySelector("strong")?.textContent).toBe("the");
    expect(reader.querySelector("script")).toBeNull();
    const link = within(reader).getByRole("link", { name: "map" });
    expect([link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["_blank", "noreferrer"]);
    expect(within(screen.getByRole("list", { name: "Notes" })).getByRole("link", { name: /rome\.md/ }).getAttribute("aria-current")).toBe("true");
    // The reader reads the file through the API at its path under memory, and offers a way back on a narrow screen.
    expect(requested(/GET \/api\/dots\/d1\/files$/)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "All notes" }).getAttribute("href")).toBe("/dots/d1/memory");
  });

  it("shows a note that is not Markdown as it is written", async () => {
    plane.putFile("/home/dot/memory/todo.txt", "# not a heading\n- not a list");
    await renderMemory({ note: "todo.txt" });
    expect((await screen.findByLabelText("Contents of todo.txt")).textContent).toBe("# not a heading\n- not a list");
    expect(screen.queryByRole("heading", { name: "not a heading" })).toBeNull();
  });

  it("says there is no such note when the address names one the folder does not hold, and reads no file for it", async () => {
    plane.putFile("/home/dot/memory/fares.md", "a");
    await renderMemory({ note: "../etc/passwd" });
    expect(await screen.findByText("There is no note called ../etc/passwd (any more).")).toBeTruthy();
    expect(requested(/GET \/api\/dots\/d1\/files$/)).toEqual([]);
  });

  it("marks a note the Dot writes while the page is open, as a chip that leads to it, and lists it", async () => {
    plane.putFile("/home/dot/memory/fares.md", "a", hoursAgo(5));
    await renderMemory();
    await screen.findByRole("list", { name: "Notes" });
    expect(screen.queryByText(/remembered/)).toBeNull();

    plane.putFile("/home/dot/memory/trips/lisbon.md", "Lisbon");
    act(() => plane.push("d1", "memory.written", { key: "trips/lisbon.md" }));
    const chips = await screen.findByText("remembered 1");
    const chip = within(chips.closest("[data-slot=memory-chips]") as HTMLElement).getByRole("link");
    expect(chip.textContent).toBe("trips/lisbon.md (added)");
    expect(chip.getAttribute("href")).toBe("/dots/d1/memory?note=trips%2Flisbon.md");
    // The list is read again, and the new note is in it.
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Notes" })).getAllByRole("listitem")).toHaveLength(2));

    // A note it writes again is an update, and moves to the front of the chips.
    act(() => plane.push("d1", "memory.written", { key: "fares.md" }));
    await screen.findByText("remembered 2");
    const links = within(screen.getByText("remembered 2").closest("[data-slot=memory-chips]") as HTMLElement).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["fares.md (updated)", "trips/lisbon.md (added)"]);
  });

  it("reads a note again when the Dot rewrites the one that is open", async () => {
    plane.putFile("/home/dot/memory/fares.md", "Cheapest in May.", hoursAgo(5));
    await renderMemory({ note: "fares.md" });
    expect((await screen.findByLabelText("Contents of fares.md")).textContent).toContain("Cheapest in May.");
    plane.putFile("/home/dot/memory/fares.md", "Cheapest in June.", hoursAgo(0));
    act(() => plane.push("d1", "memory.written", { key: "fares.md" }));
    await waitFor(() => expect(screen.getByLabelText("Contents of fares.md").textContent).toContain("Cheapest in June."));
  });

  it("says when the list stops at its limit, and that the Files view has the rest", async () => {
    for (let i = 0; i < MAX_NOTE_FOLDERS + 2; i++) plane.putFile(`/home/dot/memory/f${i}/n.md`, "x");
    await renderMemory();
    expect(await screen.findByText(/more folders than are listed here/)).toBeTruthy();
  });

  it("shows a failure of the listing, not an empty list", async () => {
    plane.failFiles = { status: 502, error: "guest_unreachable", message: "the Dot's computer did not answer" };
    await renderMemory();
    expect(await screen.findByText("Could not read the notes")).toBeTruthy();
    expect(screen.getByText("the Dot's computer did not answer")).toBeTruthy();
    expect(screen.queryByText(/has not written a note yet/)).toBeNull();
  });
});

describe("the memory switch", () => {
  const config = { goal: "watch the fares", permissions: {}, memory: { enabled: true }, limits: { max_steps_per_task: 60 } };
  /** A config as the record carries it: the shape of the schema is not what these tests are about. */
  const configOf = (value: object) => value as unknown as DotConfig;

  it("turns memory off by saving the whole config with that one field changed, on the version it read", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: configOf(config), config_version: 4 })];
    await renderMemory();
    const user = userEvent.setup();
    const control = await screen.findByRole("switch", { name: /Memory is on/ });
    expect(control.getAttribute("aria-checked")).toBe("true");
    await user.click(control);
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect(plane.updates[0]).toEqual({ config: { goal: "watch the fares", permissions: {}, memory: { enabled: false }, limits: { max_steps_per_task: 60 } }, expected_config_version: 4 });
    expect(await screen.findByText("Memory is off. The change applies from the Dot's next turn.")).toBeTruthy();
    // The page read the Dot again: the switch follows what is saved, and the explanation says what off means.
    const off = await screen.findByRole("switch", { name: /Memory is off/ });
    expect(off.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/not offered the tools that search and read its notes/)).toBeTruthy();
  });

  it("still lists the notes on the disk while memory is off", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: configOf({ ...config, memory: { enabled: false } }) })];
    plane.putFile("/home/dot/memory/fares.md", "a");
    await renderMemory();
    expect(await screen.findByRole("list", { name: "Notes" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Memory is off/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("turns memory back on", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: configOf({ ...config, memory: { enabled: false } }), config_version: 2 })];
    await renderMemory();
    await userEvent.setup().click(await screen.findByRole("switch", { name: /Memory is off/ }));
    await waitFor(() => expect(plane.updates).toHaveLength(1));
    expect(plane.updates[0]).toMatchObject({ config: { memory: { enabled: true } }, expected_config_version: 2 });
    expect(await screen.findByText("Memory is on. The change applies from the Dot's next turn.")).toBeTruthy();
  });

  it("does not undo a change made elsewhere: a config that moved on is refused, said, and read again", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", config: configOf(config), config_version: 4 })];
    await renderMemory();
    const control = await screen.findByRole("switch", { name: /Memory is on/ });
    // Another tab saved the config after this page read it.
    plane.dots[0]!.config_version = 5;
    await userEvent.setup().click(control);
    expect(await screen.findByText("Memory was not changed")).toBeTruthy();
    expect(screen.getByText(/changed after you read it/)).toBeTruthy();
    expect(plane.dots[0]!.config.memory.enabled).toBe(true);
    // The page asked for the Dot again, so the next try carries the version that is now true.
    await waitFor(() => expect(requested(/^GET \/api\/dots\/d1$/).length).toBeGreaterThan(1));
    await userEvent.setup().click(screen.getByRole("switch", { name: /Memory is on/ }));
    await waitFor(() => expect(plane.updates.at(-1)?.expected_config_version).toBe(5));
  });

  it("is not on the Automations view, which has nothing to do with it", async () => {
    await renderMemory({ view: "automations" });
    await screen.findByText(/no automations/);
    expect(screen.queryByRole("switch", { name: /Memory/ })).toBeNull();
  });
});

function automation(id: string, change: Partial<Automation> = {}): Automation {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Rome" },
    message: "Check the fares and tell me if one dropped.",
    next_run_at_ms: Date.now() + 3 * 3_600_000 + 60_000,
    last_run_at_ms: null,
    last_status: null,
    last_error: null,
    delete_after_run: false,
    created_at_ms: Date.now() - 86_400_000,
    ...change,
  };
}

describe("the automations", () => {
  it("shows each with its schedule in words, when it runs next, its last run and what the Dot is told, soonest first", async () => {
    plane.automations = [
      automation("later", { name: "Evening digest", schedule: { kind: "every", every_ms: 86_400_000 }, next_run_at_ms: Date.now() + 9 * 3_600_000, message: "Send me a digest" }),
      automation("soon", {
        name: "Morning fares",
        last_run_at_ms: Date.now() - 2 * 3_600_000 - 60_000,
        last_status: "error",
        last_error: "the page did not load",
      }),
    ];
    await renderMemory({ view: "automations" });
    const cards = await screen.findAllByRole("article");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["Morning fares", "Evening digest"]);

    const morning = within(cards[0]!);
    expect(morning.getByText("every weekday at 09:00 (Europe/Rome)")).toBeTruthy();
    expect(morning.getByText(/\(in 3h\)$/)).toBeTruthy();
    expect(morning.getByText("Failed")).toBeTruthy();
    expect(morning.getByText(/\(2h ago\)$/)).toBeTruthy();
    expect(morning.getByText("the page did not load")).toBeTruthy();
    expect(morning.getByText(/Check the fares and tell me/)).toBeTruthy();
    expect(morning.getByRole("switch", { name: "Morning fares is switched on" }).getAttribute("aria-checked")).toBe("true");

    const evening = within(cards[1]!);
    expect(evening.getByText("every day")).toBeTruthy();
    expect(evening.getByText("Has not run yet")).toBeTruthy();
  });

  it("pauses an automation through the API, then shows it paused", async () => {
    plane.automations = [automation("a1", { name: "Morning fares" })];
    await renderMemory({ view: "automations" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Morning fares is switched on" }));
    await waitFor(() => expect(plane.automationActions).toEqual(['PATCH a1 {"enabled":false}']));
    expect(await screen.findByText("Paused Morning fares.")).toBeTruthy();
    const card = within(screen.getByRole("article", { name: "Morning fares" }));
    await waitFor(() => expect(card.getByText("Paused")).toBeTruthy());
    expect(card.getByRole("switch").getAttribute("aria-checked")).toBe("false");

    await user.click(card.getByRole("switch"));
    await waitFor(() => expect(plane.automationActions.at(-1)).toBe('PATCH a1 {"enabled":true}'));
    expect(await screen.findByText("Resumed Morning fares.")).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole("article", { name: "Morning fares" })).queryByText("Paused")).toBeNull());
    expect(within(screen.getByRole("article", { name: "Morning fares" })).getByText(/\((in 1m|Just now)\)$/)).toBeTruthy();
  });

  it("keeps the switch where it was when the pause is refused, and says why", async () => {
    plane.automations = [automation("a1", { name: "Morning fares" })];
    plane.failAutomation = { status: 502, error: "guest_unreachable", message: "the Dot's computer did not answer" };
    await renderMemory({ view: "automations" });
    await userEvent.setup().click(await screen.findByRole("switch", { name: "Morning fares is switched on" }));
    expect(await screen.findByText("Morning fares was not changed")).toBeTruthy();
    expect(screen.getByText("the Dot's computer did not answer")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Morning fares is switched on" }).getAttribute("aria-checked")).toBe("true");
  });

  it("asks before it deletes, keeps the automation on Keep it, and deletes it on confirm", async () => {
    plane.automations = [automation("a1", { name: "Morning fares" }), automation("a2", { name: "Evening digest", next_run_at_ms: Date.now() + 9 * 3_600_000 })];
    await renderMemory({ view: "automations" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete Morning fares" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Morning fares?" });
    expect(dialog.textContent).toContain("cannot be undone");
    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(plane.automationActions).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Delete Morning fares" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Delete Morning fares?" })).getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(plane.automationActions).toEqual(["DELETE a1"]));
    expect(await screen.findByText("Deleted Morning fares.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("article", { name: "Morning fares" })).toBeNull());
    expect(screen.getByRole("article", { name: "Evening digest" })).toBeTruthy();
  });

  it("keeps the question open with the error when the delete fails", async () => {
    plane.automations = [automation("a1", { name: "Morning fares" })];
    plane.failAutomation = { status: 502, error: "guest_unreachable", message: "the Dot's computer did not answer" };
    await renderMemory({ view: "automations" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete Morning fares" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete automation" }));
    expect(await within(dialog).findByText("The automation was not deleted")).toBeTruthy();
    // The automation is still there (behind the question, which hides the page from the screen reader).
    expect(screen.getByRole("article", { name: "Morning fares", hidden: true })).toBeTruthy();
    expect(plane.automationActions).toEqual(["DELETE a1"]);
  });

  it("says how an automation comes to exist, by what the config does with the permission", async () => {
    await renderMemory({ view: "automations" });
    expect((await screen.findByText(/no automations/)).textContent).toMatch(/asks you first/);
    cleanup();
    plane.dots = [dotRecord("d1", { name: "fares", config: { goal: "g", permissions: { automations: "deny" }, memory: { enabled: true } } as unknown as DotConfig })];
    await renderMemory({ view: "automations" });
    expect((await screen.findByText(/no automations/)).textContent).toMatch(/cannot set any up/);
  });

  it("reads the list again when the Dot's cron tool was called, and when a run ends", async () => {
    plane.automations = [];
    await renderMemory({ view: "automations" });
    await screen.findByText(/no automations/);
    const before = requested(/GET \/api\/dots\/d1\/automations$/).length;

    plane.automations = [automation("a1", { name: "Morning fares" })];
    act(() => plane.push("d1", "tool.called", { tool: "exec", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 5 }));
    // Another tool does not change the list: nothing is asked for it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requested(/GET \/api\/dots\/d1\/automations$/)).toHaveLength(before);

    act(() => plane.push("d1", "tool.called", { tool: "cron", permission: "automations", decision: "allow", ok: true, duration_ms: 5 }));
    expect(await screen.findByRole("article", { name: "Morning fares" })).toBeTruthy();

    plane.automations = [automation("a1", { name: "Morning fares", last_run_at_ms: Date.now(), last_status: "ok" })];
    act(() => plane.push("d1", "message.assistant", { text: "dropped to 80 euro" }));
    await waitFor(() => expect(within(screen.getByRole("article", { name: "Morning fares" })).getByText("Ran")).toBeTruthy());
  });
});
