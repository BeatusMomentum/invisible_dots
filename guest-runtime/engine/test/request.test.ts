import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "@invisible-dots/shared";
import { alignCut, chooseCut } from "../src/agent/compression.js";
import { buildSystemPrompt, openCalls, toRequestMessages, type ThreadMessage } from "../src/dot/index.js";

const call = (id: string) => ({ id, type: "function" as const, function: { name: "files_read", arguments: "{}" } });

describe("the request of a step", () => {
  it("cuts a thread only where no call is separated from its results, and never past the newest answer", () => {
    const withTools: ThreadMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "A" },
      { role: "tool", tool_call_id: "b", content: "B" },
      { role: "assistant", content: "done" },
      { role: "user", content: "more" },
    ];
    expect(alignCut(withTools, 2)).toBe(4);
    expect(alignCut(withTools, 3)).toBe(4);
    expect(alignCut(withTools, 6)).toBe(4);
    expect(alignCut(withTools, 1)).toBe(1);
    const size = () => 10;
    expect(chooseCut(withTools, 25, size)).toBe(4);
    expect(chooseCut(withTools, 1000, size)).toBe(0);
  });

  it("finds the tool calls of the newest assistant message that have no result, with their positions", () => {
    const stored = (messages: ThreadMessage[]) => messages.map((message, i) => ({ id: 10 + i, thread: "t", message, createdAt: "" }));
    const thread: ThreadMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b"), call("c")] },
      { role: "tool", tool_call_id: "a", content: "A" },
    ];
    const open = openCalls(stored(thread))!;
    expect(open.messageId).toBe(11);
    expect(open.calls.map((c) => [c.call.id, c.index])).toEqual([
      ["b", 1],
      ["c", 2],
    ]);
    expect(openCalls(stored([...thread, { role: "user", content: "new" }]))).toBeNull();
    expect(openCalls(stored([{ role: "assistant", content: "plain" }]))).toBeNull();
  });

  it("sends only the newest images and notes the dropped ones", () => {
    const img = (n: number) => ({ mimeType: "image/png", base64: `IMG${n}` });
    const thread: ThreadMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: "old", images: [img(1), img(2)] },
      { role: "assistant", content: null, tool_calls: [call("b"), call("c")] },
      { role: "tool", tool_call_id: "b", content: "new1", images: [img(3)] },
      { role: "tool", tool_call_id: "c", content: "new2", images: [img(4)] },
    ];
    const out = toRequestMessages(thread, 3);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant", "tool", "tool", "user"]);
    expect(out[1]!.content).toBe("old\n[1 older image(s) from this call are no longer shown]");
    const urls = (i: number) =>
      (out[i]!.content as { type: string; image_url?: { url: string } }[]).filter((p) => p.type === "image_url").map((p) => p.image_url!.url);
    expect(urls(2)).toEqual(["data:image/png;base64,IMG2"]);
    expect(urls(6)).toEqual(["data:image/png;base64,IMG3", "data:image/png;base64,IMG4"]);
    expect(JSON.stringify(out)).not.toContain('"images"');
  });

  it("builds a system prompt that respects memory.enabled and managed_by_dot", () => {
    const config = parseRuntimeConfig({
      name: "x",
      goal: "g",
      model: { provider: "openrouter", id: "m/x" },
      memory: { enabled: false },
      browser: { identities: { managed_by_dot: false } },
    });
    const prompt = buildSystemPrompt({ config, identities: [], memoryKeys: ["k"], now: new Date(0) });
    expect(prompt).not.toContain("Long-term memory keys");
    expect(prompt).toContain("managed by your owner");
    expect(prompt).toContain("1970-01-01T00:00:00.000Z");
  });
});
