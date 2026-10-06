// @vitest-environment jsdom
import { APPROVAL_NOTE_MAX } from "@invisible-dots/shared/browser";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/components/approvals/ApprovalCard";
import { DiffPreview, PREVIEW_LINES } from "../src/components/approvals/diff-preview";
import { useApprovalAnswers } from "../src/components/approvals/use-answers";
import { ApprovalCard as ApprovalCardElement } from "../src/components/elements/approval-card";
import { EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import type { ApprovalAsk } from "../src/lib/approval-view";
import { additionDiff } from "../src/lib/diff";
import { stubMatchMedia } from "./support/browser";
import { approvalRecord, dotRecord, FakeControlPlane } from "./support/control-plane";

vi.mock("next/navigation", () => ({ usePathname: () => "/inbox", useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  window.localStorage.clear();
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" })];
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function askOf(id: string, change: Partial<ApprovalAsk> = {}): ApprovalAsk {
  return { id, dotId: "d1", taskId: null, tool: "exec", permission: "computer.exec", arguments: { command: "make test" }, reason: "to run the tests", createdAt: "2026-01-01T00:00:00Z", ...change };
}

/** The host holds the approval, as it does for any approval a card is shown for. */
function hold(ask: ApprovalAsk) {
  plane.approvals.push(approvalRecord(ask.id, ask.dotId, { task_id: ask.taskId, tool: ask.tool, permission: ask.permission, arguments: ask.arguments, reason: ask.reason }));
}

function Card({ ask }: { ask: ApprovalAsk }) {
  const answers = useApprovalAnswers();
  return <ApprovalCard ask={ask} answers={answers} dotName="fares" />;
}

function renderCard(ask: ApprovalAsk) {
  hold(ask);
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <Card ask={ask} />
      </AttentionProvider>
    </EventStreamProvider>,
  );
  return screen.findByRole("article", { name: /^Wants to / });
}

describe("the approval card", () => {
  it("says what the Dot wants to do, which Dot, under which permission and how risky, and why", async () => {
    const card = within(await renderCard(askOf("a1")));
    expect(card.getByText("Wants to run a command")).toBeTruthy();
    expect(card.getByText("fares")).toBeTruthy();
    expect(card.getByText("Run commands (high risk)")).toBeTruthy();
    expect(card.getByText("to run the tests")).toBeTruthy();
    expect(card.getByText("make test")).toBeTruthy();
    expect(card.getByRole("link", { name: "In the chat" }).getAttribute("href")).toBe("/dots/d1/chat");
    // A card that waits says that the Dot keeps waiting.
    expect(card.getByText(/keeps waiting across restarts/)).toBeTruthy();
  });

  it("links the task that asked, when a task did", async () => {
    const card = within(await renderCard(askOf("a1", { taskId: "task_9" })));
    expect(card.getByRole("link", { name: "From a task" }).getAttribute("href")).toBe("/dots/d1/tasks/task_9");
  });

  it("shows the raw arguments under Details", async () => {
    const card = within(await renderCard(askOf("a1", { arguments: { command: "make test", timeout: 30 } })));
    const details = card.getByText("Details").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")?.textContent).toBe(JSON.stringify({ command: "make test", timeout: 30 }, null, 2));
  });

  it("is the destructive variant for a command, a deleted identity and a file outside the workspace, and the ordinary one otherwise", async () => {
    const variantOf = async (ask: ApprovalAsk) => {
      cleanup();
      plane.approvals = [];
      return (await renderCard(ask)).querySelector("[data-slot=approval-card]")?.getAttribute("data-variant");
    };
    expect(await variantOf(askOf("a1"))).toBe("destructive");
    expect(await variantOf(askOf("a2", { tool: "browser_identity_delete", permission: "browser.identity.delete", arguments: { identity_id: "shop-abc123" } }))).toBe("destructive");
    expect(await variantOf(askOf("a3", { tool: "write_file", permission: "files.write", arguments: { path: "/etc/hosts", content: "x" } }))).toBe("destructive");
    expect(await variantOf(askOf("a4", { tool: "write_file", permission: "files.write", arguments: { path: "notes.md", content: "x" } }))).toBe("default");
    expect(await variantOf(askOf("a5", { tool: "browser_navigate", permission: "browser.navigate", arguments: { identity_id: "x", url: "https://example.com" } }))).toBe("default");
  });

  it("allows once with one press, and is left as a receipt", async () => {
    const card = within(await renderCard(askOf("a1")));
    await userEvent.click(card.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(card.getByRole("status").textContent).toBe("Allowed"));
    expect(plane.answers).toEqual([{ id: "a1", decision: "approve", body: {} }]);
    expect(card.queryByRole("button")).toBeNull();
    // What would be allowed is no longer asked: the receipt keeps the question and the reason only.
    expect(card.queryByText("make test")).toBeNull();
    expect(card.getByText("to run the tests")).toBeTruthy();
  });

  it("denies, with the note the person wrote, which the Dot receives and the receipt repeats", async () => {
    const card = within(await renderCard(askOf("a1")));
    expect(card.queryByLabelText(/Note for the Dot/)).toBeNull();
    await userEvent.click(card.getByRole("button", { name: "Add a note for the Dot" }));
    await userEvent.type(card.getByLabelText("Note for the Dot (optional)"), "  not on this machine ");
    await userEvent.click(card.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(card.getByRole("status").textContent).toContain("Denied"));
    expect(plane.answers).toEqual([{ id: "a1", decision: "reject", body: { note: "not on this machine" } }]);
    expect(card.getByText("Your note: not on this machine")).toBeTruthy();
  });

  it("takes a note of the length the control plane takes, no longer", async () => {
    const card = within(await renderCard(askOf("a1")));
    await userEvent.click(card.getByRole("button", { name: "Add a note for the Dot" }));
    expect((card.getByLabelText("Note for the Dot (optional)") as HTMLInputElement).maxLength).toBe(APPROVAL_NOTE_MAX);
  });

  it("does not send a note that is only blanks", async () => {
    const card = within(await renderCard(askOf("a1")));
    await userEvent.click(card.getByRole("button", { name: "Add a note for the Dot" }));
    await userEvent.type(card.getByLabelText("Note for the Dot (optional)"), "   ");
    await userEvent.click(card.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(plane.answers).toHaveLength(1));
    expect(plane.answers[0]!.body).toEqual({});
  });

  it("asks what always allow changes before it does it, and does it only when the person confirms", async () => {
    const card = within(await renderCard(askOf("a1")));
    await userEvent.click(card.getByRole("button", { name: "Always allow" }));
    const dialog = await screen.findByRole("dialog", { name: /Always allow .Run commands.\?/ });
    expect(within(dialog).getByText(/computer\.exec: allow/)).toBeTruthy();
    expect(within(dialog).getByText("High risk")).toBeTruthy();
    // The tools the permission covers, from the Dot's own table.
    const covered = await within(dialog).findByRole("list", { name: "Tools covered" });
    expect(within(covered).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["exec", "exec_session"]);
    expect(plane.requests).toContain("GET /api/dots/d1/tools");
    expect(plane.answers).toEqual([]);

    await userEvent.click(within(dialog).getByRole("button", { name: "Keep asking" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(plane.answers).toEqual([]);
    expect(card.getByRole("button", { name: "Allow once" })).toBeTruthy();

    await userEvent.click(card.getByRole("button", { name: "Always allow" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(card.getByRole("status").textContent).toContain('Allowed. The Dot will not ask for "Run commands" again.'));
    expect(plane.answers).toEqual([{ id: "a1", decision: "approve", body: { always: true } }]);
  });

  it("says so when the Dot's computer cannot list its tools, and still lets the person decide", async () => {
    plane.tools = null;
    const card = within(await renderCard(askOf("a1")));
    await userEvent.click(card.getByRole("button", { name: "Always allow" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/did not answer, so the tools are not listed/)).toBeTruthy();
    expect(within(dialog).queryByRole("list", { name: "Tools covered" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(plane.answers).toHaveLength(1));
  });

  it("offers no always allow for a permission a config can no longer name, because the host would refuse it", async () => {
    const card = within(await renderCard(askOf("a1", { tool: "web_search", permission: "web.search", arguments: { query: "x" } })));
    expect(card.getByText("web.search")).toBeTruthy();
    expect(card.queryByRole("button", { name: "Always allow" })).toBeNull();
    expect(card.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(card.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("says that the approval was answered somewhere else when the host answers 409, without calling it a failure", async () => {
    const ask = askOf("a1");
    const card = within(await renderCard(ask));
    plane.approvals[0]!.status = "approved";
    await userEvent.click(card.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(card.getByRole("status").textContent).toBe("Already answered, on another tab or another channel"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(card.queryByRole("button")).toBeNull();
  });

  it("shows why an answer was not recorded, and lets the person answer again", async () => {
    const card = within(await renderCard(askOf("a1")));
    plane.failAnswer = { status: 500, error: "internal", message: "the database is down" };
    await userEvent.click(card.getByRole("button", { name: "Deny" }));
    expect((await card.findByRole("alert")).textContent).toContain("the database is down");
    expect(card.getByRole("button", { name: "Deny" })).toHaveProperty("disabled", false);
    expect(card.queryByRole("status")).toBeNull();

    plane.failAnswer = null;
    await userEvent.click(card.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(card.getByRole("status").textContent).toContain("Denied"));
    expect(card.queryByRole("alert")).toBeNull();
  });

  it("answers once, however many times the button is pressed while the answer is on its way", async () => {
    const ask = askOf("a1");
    hold(ask);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = plane.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/approve")) await gate;
        return real(input, init);
      }),
    );
    render(
      <EventStreamProvider>
        <AttentionProvider>
          <Card ask={ask} />
        </AttentionProvider>
      </EventStreamProvider>,
    );
    const card = within(await screen.findByRole("article", { name: "Wants to run a command" }));
    const allow = card.getByRole("button", { name: "Allow once" });
    await userEvent.click(allow);
    // The three buttons wait; a second press goes nowhere.
    await waitFor(() => expect(allow).toHaveProperty("disabled", true));
    expect(card.getByRole("button", { name: "Deny" })).toHaveProperty("disabled", true);
    await userEvent.click(allow);
    release();
    await waitFor(() => expect(card.getByRole("status").textContent).toBe("Allowed"));
    expect(plane.answers).toHaveLength(1);
  });
});

describe("what a tool's card shows", () => {
  it("shows an edit as a change, in the colors of what it does", async () => {
    const card = within(await renderCard(askOf("a1", { tool: "edit_file", permission: "files.write", arguments: { path: "report.md", old_text: "draft", new_text: "final", replace_all: true } })));
    expect(card.getByText(/every place the old text is found/)).toBeTruthy();
    const preview = card.getByRole("group", { name: "Change to report.md" });
    expect([...preview.querySelectorAll("[data-kind]")].map((line) => `${line.getAttribute("data-kind")}:${line.lastElementChild?.textContent}`)).toEqual(["remove:draft", "add:final"]);
    expect(preview.querySelector("[data-kind=remove]")?.className).toContain("text-danger");
    expect(preview.querySelector("[data-kind=add]")?.className).toContain("text-ok");
  });

  it("shows a written file as everything added, and says it replaces what is there", async () => {
    const card = within(await renderCard(askOf("a1", { tool: "write_file", permission: "files.write", arguments: { path: "notes.md", content: "one\ntwo" } })));
    expect(card.getByText(/replacing what is in it now/)).toBeTruthy();
    expect(card.getByRole("group", { name: "New content of notes.md" }).querySelectorAll("[data-kind=add]")).toHaveLength(2);
  });

  it("shows a browser call as its facts, an identity's proxy without its password, and an automation as its schedule", async () => {
    const page = within(await renderCard(askOf("a1", { tool: "browser_navigate", permission: "browser.navigate", arguments: { identity_id: "shop-abc123", url: "https://example.com/cart" } })));
    expect(page.getByText("Address")).toBeTruthy();
    expect(page.getByText("https://example.com/cart")).toBeTruthy();
    cleanup();
    plane.approvals = [];

    const identity = within(await renderCard(askOf("a2", { tool: "browser_identity_create", permission: "browser.identity.create", arguments: { name: "shop", proxy: "http://u:hunter2@proxy.example:8080" } })));
    expect(identity.getByText("http://u:***@proxy.example:8080")).toBeTruthy();
    // The password is in no text of the card, the raw arguments included.
    expect(identity.getByText("Details").closest("details")?.textContent).not.toContain("hunter2");
    cleanup();
    plane.approvals = [];

    const cron = within(await renderCard(askOf("a3", { tool: "cron", permission: "automations", arguments: { action: "add", name: "standup", message: "Say hello", every_seconds: 3600 } })));
    expect(cron.getByText("every hour")).toBeTruthy();
  });
});

describe("a diff preview", () => {
  it("cuts a long change at a number of lines and opens the rest on request", async () => {
    const lines = additionDiff(Array.from({ length: PREVIEW_LINES + 7 }, (_, i) => `line ${i}`).join("\n"));
    render(<DiffPreview lines={lines} label="New content" />);
    const preview = screen.getByRole("group", { name: "New content" });
    expect(preview.querySelectorAll("[data-kind]")).toHaveLength(PREVIEW_LINES);
    expect(screen.getByText(`+${PREVIEW_LINES + 7}`)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show the other 7 lines" }));
    expect(preview.querySelectorAll("[data-kind]")).toHaveLength(PREVIEW_LINES + 7);
    expect(screen.queryByRole("button", { name: /Show the other/ })).toBeNull();
  });

  it("says when nothing changes, and keeps a line's sign out of its text", () => {
    const { unmount } = render(<DiffPreview lines={[]} label="Nothing" />);
    expect(screen.getByText("Nothing is added or removed.")).toBeTruthy();
    unmount();
    render(<DiffPreview lines={[{ kind: "remove", text: "- a list item" }]} label="One" />);
    const row = screen.getByRole("group", { name: "One" }).querySelector("[data-kind=remove]")!;
    // The sign is drawn aside and hidden from assistive technology, which hears "Removed" instead.
    expect(row.querySelector("[aria-hidden=true]")?.textContent).toBe("-");
    expect(row.textContent).toContain("Removed: ");
    expect(row.textContent).toContain("- a list item");
  });
});

describe("the approval card element", () => {
  it("keeps its answers in order: deny, always allow, allow once; and shows the details list", () => {
    render(
      <ApprovalCardElement
        state="request"
        title="Wants to do a thing"
        subtitle="Sub"
        details={[{ label: "Where", value: "there" }]}
        onDeny={() => {}}
        onAlwaysAllow={() => {}}
        onAllowOnce={() => {}}
      />,
    );
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Deny", "Always allow", "Allow once"]);
    expect(screen.getByText("Where")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Wants to do a thing" })).toBeTruthy();
  });

  it("is only a receipt once answered, in each of the four ways", () => {
    for (const [state, words] of [
      ["approved", "Allowed"],
      ["rejected", "Denied"],
      ["expired", "Expired: the task ended before anyone answered"],
      ["elsewhere", "Already answered, on another tab or another channel"],
    ] as const) {
      const { unmount } = render(<ApprovalCardElement state={state} title="T" onAllowOnce={() => {}} onDeny={() => {}}>body</ApprovalCardElement>);
      expect(screen.getByRole("status").textContent).toBe(words);
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByText("body")).toBeNull();
      unmount();
    }
  });
});
