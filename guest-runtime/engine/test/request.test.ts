import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "@invisible-dots/shared";
import { buildSystemPrompt, toRequestMessages, trimThread, unansweredToolCalls, type ThreadMessage } from "../src/dot/index.js";

const call = (id: string) => ({ id, type: "function" as const, function: { name: "files_read", arguments: "{}" } });

describe("the request of a step", () => {
  it("keeps the last 40 messages and never starts on an orphan tool result", () => {
    const messages: ThreadMessage[] = [];
    for (let i = 0; i < 50; i++) messages.push({ role: "user", content: `m${i}` });
    expect(trimThread(messages)).toHaveLength(40);
    expect(trimThread(messages)[0]).toEqual({ role: "user", content: "m10" });

    const withTools: ThreadMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "A" },
      { role: "tool", tool_call_id: "b", content: "B" },
      { role: "assistant", content: "done" },
    ];
    expect(trimThread(withTools, 3)).toEqual([{ role: "assistant", content: "done" }]);
    expect(trimThread(withTools, 4)[0]!.role).toBe("assistant");
  });

  it("finds the tool calls of the newest assistant message that have no result", () => {
    const thread: ThreadMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b"), call("c")] },
      { role: "tool", tool_call_id: "a", content: "A" },
    ];
    expect(unansweredToolCalls(thread).map((c) => c.id)).toEqual(["b", "c"]);
    expect(unansweredToolCalls([...thread, { role: "user", content: "new" }])).toEqual([]);
    expect(unansweredToolCalls([{ role: "assistant", content: "plain" }])).toEqual([]);
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
