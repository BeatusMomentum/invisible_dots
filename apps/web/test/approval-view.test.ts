import { describe, expect, it } from "vitest";
import {
  approvalBody,
  argumentFacts,
  askedTitle,
  askOfRecord,
  askTitle,
  boundedJson,
  isDestructive,
  outsideWorkspace,
  permissionInfo,
  schedulePhrase,
  toolsCovered,
  type ApprovalAsk,
} from "../src/lib/approval-view";
import { approvalRecord } from "./support/control-plane";

function ask(tool: string, permission: string, args: Record<string, unknown> = {}): ApprovalAsk {
  return { id: "a1", dotId: "d1", taskId: null, tool, permission, arguments: args, reason: "", createdAt: "2026-01-01T00:00:00Z" };
}

describe("an approval read from the host's record", () => {
  it("keeps what the card needs, with the camel-cased names of the page", () => {
    const record = approvalRecord("a7", "d3", { task_id: "t9", tool: "write_file", permission: "files.write", arguments: { path: "x" }, reason: "why", created_at: "2026-02-03T04:05:06Z" });
    expect(askOfRecord(record)).toEqual({
      id: "a7",
      dotId: "d3",
      taskId: "t9",
      tool: "write_file",
      permission: "files.write",
      arguments: { path: "x" },
      reason: "why",
      createdAt: "2026-02-03T04:05:06Z",
    });
  });
});

describe("the question and its words", () => {
  it("says what the Dot wants to do from the engine's table, and in the past for an approval already answered", () => {
    expect(askTitle(ask("exec", "computer.exec"))).toBe("Wants to run a command");
    expect(askTitle(ask("browser_identity_delete", "browser.identity.delete"))).toBe("Wants to delete a browser identity");
    expect(askedTitle(ask("write_file", "files.write"))).toBe("Asked to write a file");
    // A tool the table does not know keeps the name the model gave it.
    expect(askTitle(ask("rm_rf", "computer.exec"))).toBe("Wants to call rm_rf");
  });

  it("knows the words and the risk of a permission, and nothing of one a config can no longer name", () => {
    expect(permissionInfo("computer.exec")).toMatchObject({ label: "Run commands", risk: "high", permission: "computer.exec" });
    expect(permissionInfo("files.read")?.risk).toBe("low");
    expect(permissionInfo("web.search")).toBeNull();
    expect(permissionInfo("")).toBeNull();
  });
});

describe("what is outside the workspace", () => {
  it("treats a relative path as inside, and resolves the dots before judging", () => {
    expect(outsideWorkspace("notes.md")).toBe(false);
    expect(outsideWorkspace("./a/b.md")).toBe(false);
    expect(outsideWorkspace("a/../b.md")).toBe(false);
    expect(outsideWorkspace("../etc/passwd")).toBe(true);
    expect(outsideWorkspace("a/../../b")).toBe(true);
    expect(outsideWorkspace("/home/dot/workspace")).toBe(false);
    expect(outsideWorkspace("/home/dot/workspace/x/y.txt")).toBe(false);
    expect(outsideWorkspace("/home/dot/workspace/../memory/n.md")).toBe(true);
    // The prefix of a name is not the folder.
    expect(outsideWorkspace("/home/dot/workspace-old/x")).toBe(true);
    expect(outsideWorkspace("/etc/hosts")).toBe(true);
    expect(outsideWorkspace("~/notes.md")).toBe(true);
    expect(outsideWorkspace("~/workspace/notes.md")).toBe(false);
    expect(outsideWorkspace("~")).toBe(true);
  });
});

describe("what is destructive to allow", () => {
  it("is a command, the deletion of a browser identity, and a change to a file outside the workspace", () => {
    expect(isDestructive(ask("exec", "computer.exec", { command: "ls" }))).toBe(true);
    expect(isDestructive(ask("browser_identity_delete", "browser.identity.delete"))).toBe(true);
    expect(isDestructive(ask("write_file", "files.write", { path: "/etc/hosts", content: "" }))).toBe(true);
    expect(isDestructive(ask("edit_file", "files.write", { path: "../other.md" }))).toBe(true);
    expect(isDestructive(ask("apply_patch", "files.write", { edits: [{ path: "a.md", action: "add" }, { path: "/root/x", action: "add" }] }))).toBe(true);
  });

  it("is not a change inside the workspace, nor a page being used or a note being read", () => {
    expect(isDestructive(ask("write_file", "files.write", { path: "notes.md", content: "" }))).toBe(false);
    expect(isDestructive(ask("apply_patch", "files.write", { edits: [{ path: "a.md", action: "add" }] }))).toBe(false);
    expect(isDestructive(ask("write_file", "files.write", {}))).toBe(false);
    expect(isDestructive(ask("browser_navigate", "browser.navigate", { url: "https://example.com" }))).toBe(false);
    expect(isDestructive(ask("memory_get", "memory.read", { name: "a.md" }))).toBe(false);
  });
});

describe("the body of the card, by tool", () => {
  it("shows a command as it is, with where it runs (either spelling of the engine's arguments)", () => {
    expect(approvalBody(ask("exec", "computer.exec", { command: "make test", working_dir: "/home/dot/workspace/app" }))).toEqual({ kind: "command", command: "make test", where: "/home/dot/workspace/app" });
    expect(approvalBody(ask("exec", "computer.exec", { cmd: "ls", workdir: "/tmp" }))).toEqual({ kind: "command", command: "ls", where: "/tmp" });
    expect(approvalBody(ask("exec", "computer.exec", { command: "ls" }))).toEqual({ kind: "command", command: "ls", where: null });
  });

  it("shows a written file as added lines, and an edit as what it removes and adds", () => {
    expect(approvalBody(ask("write_file", "files.write", { path: "a.md", content: "x\ny" }))).toEqual({
      kind: "write",
      path: "a.md",
      diff: [
        { kind: "add", text: "x" },
        { kind: "add", text: "y" },
      ],
    });
    expect(approvalBody(ask("edit_file", "files.write", { path: "a.md", old_text: "old", new_text: "new", replace_all: true }))).toEqual({
      kind: "edit",
      path: "a.md",
      replaceAll: true,
      diff: [
        { kind: "remove", text: "old" },
        { kind: "add", text: "new" },
      ],
    });
  });

  it("shows a patch file by file, an added one as additions and a replaced one as a change, and says a trial run writes nothing", () => {
    const body = approvalBody(
      ask("apply_patch", "files.write", {
        dry_run: true,
        edits: [
          { path: "a.md", action: "replace", old_text: "1", new_text: "2" },
          { path: "b.md", action: "add", new_text: "tail" },
          { action: "add", new_text: "no path: left out" },
          "not an object",
        ],
      }),
    );
    expect(body).toMatchObject({ kind: "patch", dryRun: true });
    if (body.kind !== "patch") throw new Error("not a patch");
    expect(body.files.map((file) => [file.path, file.action, file.diff.map((line) => line.kind)])).toEqual([
      ["a.md", "replace", ["remove", "add"]],
      ["b.md", "add", ["add"]],
    ]);
  });

  it("falls back to the facts when a tool's arguments are not what it takes (a call the engine refuses)", () => {
    expect(approvalBody(ask("exec", "computer.exec", { timeout: 5 }))).toEqual({ kind: "facts", facts: [{ label: "Timeout", value: "5" }] });
    expect(approvalBody(ask("write_file", "files.write", { path: "a.md" }))).toMatchObject({ kind: "facts" });
    expect(approvalBody(ask("apply_patch", "files.write", { edits: [] }))).toEqual({ kind: "facts", facts: [] });
  });

  it("lists the address, the browser and the key of a page tool", () => {
    expect(approvalBody(ask("browser_navigate", "browser.navigate", { identity_id: "shop-abc123", url: "https://example.com/a?b=1" }))).toEqual({
      kind: "facts",
      facts: [
        { label: "Browser identity", value: "shop-abc123" },
        { label: "Address", value: "https://example.com/a?b=1" },
      ],
    });
    expect(argumentFacts({ identity_id: "x", selector: "#go", text: "hello", x: 3, y: 4 })).toEqual([
      { label: "Browser identity", value: "x" },
      { label: "Element", value: "#go" },
      { label: "Text to type", value: "hello" },
      { label: "Position", value: "3, 4" },
    ]);
  });

  it("masks the password of an identity's proxy, and keeps an argument it has no word for under its own name", () => {
    expect(argumentFacts({ name: "shop", proxy: "http://user:secret@proxy.example:8080" })).toEqual([
      { label: "Name", value: "shop" },
      { label: "Proxy", value: "http://user:***@proxy.example:8080" },
    ]);
    expect(argumentFacts({ max_output_chars: 100, flag: true, nothing: null, empty: "" })).toEqual([
      { label: "Max output chars", value: "100" },
      { label: "Flag", value: "true" },
    ]);
  });

  it("says when an automation runs, in words", () => {
    expect(schedulePhrase({ every_seconds: 1 })).toBe("every second");
    expect(schedulePhrase({ every_seconds: 45 })).toBe("every 45 seconds");
    expect(schedulePhrase({ every_seconds: 60 })).toBe("every minute");
    expect(schedulePhrase({ every_seconds: 300 })).toBe("every 5 minutes");
    expect(schedulePhrase({ every_seconds: 3600 })).toBe("every hour");
    expect(schedulePhrase({ every_seconds: 7200 })).toBe("every 2 hours");
    expect(schedulePhrase({ every_seconds: 86_400 })).toBe("every day");
    expect(schedulePhrase({ every_seconds: 90 })).toBe("every 90 seconds");
    expect(schedulePhrase({ cron_expr: "0 9 * * *", tz: "Europe/Rome" })).toBe('cron "0 9 * * *" (Europe/Rome)');
    expect(schedulePhrase({ cron_expr: "0 9 * * *" })).toBe('cron "0 9 * * *"');
    expect(schedulePhrase({ at: "not a date" })).toBe("once, at not a date");
    expect(schedulePhrase({})).toBe("");
    expect(schedulePhrase({ every_seconds: -5 })).toBe("");
  });

  it("shows an automation as its action, name, message and schedule", () => {
    const body = approvalBody(ask("cron", "automations", { action: "add", name: "standup", message: "Remind me", every_seconds: 86_400 }));
    expect(body).toEqual({
      kind: "facts",
      facts: [
        { label: "Name", value: "standup" },
        { label: "Action", value: "add" },
        { label: "Message", value: "Remind me" },
        { label: "Schedule", value: "every day" },
      ],
    });
  });
});

describe("the raw arguments", () => {
  it("are shown whole when they are small, and cut, with the fact that they were, when they are enormous", () => {
    expect(boundedJson({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}', cut: false });
    const big = boundedJson({ content: "x".repeat(50_000) });
    expect(big.cut).toBe(true);
    expect(big.text).toHaveLength(20_000);
    expect(boundedJson({ content: "x".repeat(50) }, 10).cut).toBe(true);
  });

  it("never carry the password of a proxy, whatever reached the page", () => {
    const { text } = boundedJson({ name: "shop", proxy: "http://user:hunter2@proxy.example:8080" });
    expect(text).not.toContain("hunter2");
    expect(text).toContain("http://user:***@proxy.example:8080");
  });
});

describe("the tools a permission covers", () => {
  const table = [
    { name: "exec", permission: "computer.exec" as const, offered: true, description: "" },
    { name: "read_file", permission: "files.read" as const, offered: true, description: "" },
    { name: "exec_session", permission: "computer.exec" as const, offered: false, description: "" },
  ];

  it("are those of the Dot's table that exercise it, in its order, whether or not the model is offered them now", () => {
    expect(toolsCovered("computer.exec", table)).toEqual(["exec", "exec_session"]);
    expect(toolsCovered("browser.act", table)).toEqual([]);
  });

  it("are not known when the table could not be read", () => {
    expect(toolsCovered("computer.exec", null)).toBeNull();
  });
});
