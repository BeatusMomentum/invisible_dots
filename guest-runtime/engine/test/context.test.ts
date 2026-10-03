/**
 * The context budget is a ceiling (architecture section 8.6): no request is
 * sent above it, the summary and the flush included.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatRequest } from "@invisible-dots/openrouter-client";
import { CEILING, MEMORY_FLUSH_PROMPT, SUMMARY_SYSTEM_PROMPT, placeholderText } from "../src/agent/compression.js";
import { NOT_EXECUTED_TEXT } from "../src/dot/request.js";
import { ContextBudgetError } from "../src/errors.js";
import { IMAGE_TOKENS } from "../src/utils/tokens.js";
import { baseConfig } from "./helpers.js";
import { bench, type Answer, type Bench } from "./bench.js";

let b: Bench | undefined;
afterEach(() => {
  b?.close();
  b = undefined;
});

const withBudget = (tokens: number, extra: Record<string, unknown> = {}) => ({ ...baseConfig, limits: { context_tokens: tokens }, ...extra });

/** A deterministic random source, so a failing thread can be found again. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isSummary = (r: ChatRequest) => r.messages[0]?.role === "system" && r.messages[0].content === SUMMARY_SYSTEM_PROMPT;
const isFlush = (r: ChatRequest) => r.messages.at(-1)?.content === MEMORY_FLUSH_PROMPT;

/** Answers summaries and flushes; anything else is a test fault. */
function summarizer(text: (r: ChatRequest) => Answer = () => ({ text: "the agent read files; the vault code is KESTREL-4417" })) {
  return (r: ChatRequest): Answer => {
    if (isFlush(r)) return { text: "nothing" };
    if (isSummary(r)) return text(r);
    throw new Error("unexpected request");
  };
}

/** One round: an assistant message with calls, and a result for each. */
function round(
  store: Bench["store"],
  thread: string,
  n: number,
  sizes: number[],
  options: { images?: boolean; notExecuted?: boolean; say?: number } = {},
): void {
  const calls = sizes.map((_, i) => ({ id: `c${n}_${i}`, type: "function" as const, function: { name: "files_read", arguments: JSON.stringify({ path: `f${n}_${i}` }) } }));
  const text = options.say ? `step ${n} ${"t".repeat(options.say)}` : n % 3 === 0 ? `step ${n}` : null;
  store.appendMessage(thread, { role: "assistant", content: text, tool_calls: calls });
  sizes.forEach((size, i) => {
    store.appendMessage(thread, {
      role: "tool",
      tool_call_id: calls[i]!.id,
      content: options.notExecuted ? NOT_EXECUTED_TEXT : `${"r".repeat(size)}`,
      ...(options.images ? { images: [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }] } : {}),
    });
  });
}

function pairedCalls(messages: readonly ChatMessage[]): boolean {
  const results = new Set(messages.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id));
  return messages.every((m) => m.role !== "assistant" || (m.tool_calls ?? []).every((c) => results.has(c.id)));
}

describe("the context ceiling", () => {
  it("no built request exceeds the ceiling", async () => {
    let built = 0;
    let refused = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const rand = random(seed);
      const budget = 4000 + Math.floor(rand() * 60_000);
      const chat = rand() < 0.3;
      const local = bench(withBudget(budget), { memory: true, chat });
      try {
        const thread = chat ? "conversation" : "t1";
        const rounds = Math.floor(rand() * 40);
        for (let n = 0; n < rounds; n++) {
          const sizes = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => Math.floor(rand() * rand() * 30_000));
          round(local.store, thread, n, sizes, { images: rand() < 0.2, notExecuted: rand() < 0.1, say: rand() < 0.3 ? Math.floor(rand() * 4000) : 0 });
          if (rand() < 0.2) {
            local.store.appendMessage(thread, { role: "assistant", content: "x".repeat(Math.floor(rand() * 3000)) });
            local.store.appendMessage(thread, { role: "user", content: "go on" });
          }
        }
        local.model.respond = summarizer(() => {
          const r = rand();
          return r < 0.2 ? { text: "s".repeat(200_000) } : r < 0.3 ? { text: "", finishReason: "length" } : { text: `summary ${seed}` };
        });
        try {
          const request = await local.context.prepare(local.unit());
          built++;
          expect(request.estimate, `seed ${seed}`).toBeLessThanOrEqual(budget * CEILING);
          expect(pairedCalls(request.messages), `seed ${seed}`).toBe(true);
          const start = chat ? "hello" : "do it";
          expect(request.messages.some((m) => m.role === "user" && m.content === start), `seed ${seed}`).toBe(true);
        } catch (error) {
          if (!(error instanceof ContextBudgetError)) throw error;
          refused++;
        }
        for (const sent of local.model.requests) {
          expect(local.estimator.estimate(local.config.model.id, sent.messages, sent.tools), `seed ${seed}`).toBeLessThanOrEqual(budget * CEILING);
        }
      } finally {
        local.close();
      }
    }
    expect(built).toBeGreaterThan(450);
    expect(built + refused).toBe(500);
  }, 120_000);

  it("the summary call is bounded", async () => {
    b = bench(withBudget(8000));
    for (let n = 0; n < 40; n++) round(b.store, "t1", n, [20_000]);
    b.model.respond = summarizer();
    const request = await b.context.prepare(b.unit());
    expect(request.estimate).toBeLessThanOrEqual(8000 * CEILING);
    const summaries = b.model.requests.filter(isSummary);
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) expect(b.estimator.estimate(b.config.model.id, s.messages)).toBeLessThanOrEqual(8000 * 0.6);
  });

  it("the stored summary never exceeds 0.15 of the budget, mechanical fallback included", async () => {
    for (const answer of [{ text: "w".repeat(300_000) }, { text: "", finishReason: "length" }]) {
      b = bench(withBudget(10_000));
      for (let n = 0; n < 30; n++) round(b.store, "t1", n, [9000]);
      b.model.respond = summarizer(() => answer);
      await b.context.prepare(b.unit());
      const summary = b.store.latestSummary("t1")!;
      expect(b.estimator.textTokens(b.config.model.id, summary.summary)).toBeLessThanOrEqual(10_000 * 0.15);
      b.close();
      b = undefined;
    }
  });

  it("a budget too small fails the unit without a request", async () => {
    b = bench(withBudget(4000));
    b.store.appendMessage("t1", { role: "user", content: "z".repeat(60_000) });
    await expect(b.run()).rejects.toThrow("the context budget (limits.context_tokens = 4000) is too small for the current step");
    expect(b.model.requests).toEqual([]);
  });

  it("placeholders come before the summary", async () => {
    b = bench(withBudget(20_000));
    for (let n = 0; n < 4; n++) round(b.store, "t1", n, [12_000]);
    b.model.respond = summarizer();
    const request = await b.context.prepare(b.unit());
    expect(b.model.requests).toEqual([]);
    const tools = request.messages.filter((m) => m.role === "tool").map((m) => m.content as string);
    expect(tools.slice(0, 2)).toEqual([placeholderText("files_read", 12_000), placeholderText("files_read", 12_000)]);
    expect(tools.at(-1)).toHaveLength(12_000);
  });

  it("images are charged, and only the newest are sent", async () => {
    b = bench(withBudget(64_000));
    const image: ChatMessage = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] };
    expect(b.estimator.estimate("m", [image])).toBeGreaterThanOrEqual(IMAGE_TOKENS);
    for (let n = 0; n < 6; n++) round(b.store, "t1", n, [10], { images: true });
    const request = await b.context.prepare(b.unit());
    const images = request.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : []));
    expect(images).toHaveLength(3);
    expect(request.estimate).toBeGreaterThanOrEqual(3 * IMAGE_TOKENS);
  });

  it("the flush saves memories through the registry, and the summary lists them", async () => {
    // Over the trigger once the consumed results are placeholders, with room left for the flush itself.
    b = bench(withBudget(20_000));
    const saved = new Map<string, string>();
    b.registry.handlers.set("memory_remember", (args) => {
      const a = args as { key: string; content: string };
      saved.set(a.key, a.content);
      b!.store.remember(a.key, a.content);
      return { ok: true, text: "remembered" };
    });
    for (let n = 0; n < 18; n++) round(b.store, "t1", n, [3000], { say: 2500 });
    b.model.respond = (r) =>
      isFlush(r)
        ? { calls: [{ id: "m1", type: "function", function: { name: "memory_remember", arguments: JSON.stringify({ key: "vault", content: "KESTREL-4417" }) } }] }
        : { text: "summary" };
    const request = await b.context.prepare(b.unit());
    expect(saved.get("vault")).toBe("KESTREL-4417");
    expect(b.store.readAfter(0).filter((e) => e.type === "tool.called").map((e) => e.data)).toEqual([
      expect.objectContaining({ tool: "memory_remember", permission: "memory.write", decision: "allow", ok: true }),
    ]);
    expect(request.messages.some((m) => typeof m.content === "string" && m.content.includes("- vault: KESTREL-4417"))).toBe(true);
  });

  it("the flush is skipped when its own request would exceed the ceiling", async () => {
    b = bench(withBudget(8000));
    for (let n = 0; n < 6; n++) round(b.store, "t1", n, [2000], { say: 2500 });
    // The newest round alone is above the trigger: no flush fits.
    round(b.store, "t1", 99, [17_000]);
    b.model.respond = summarizer();
    const request = await b.context.prepare(b.unit());
    expect(b.model.requests.some(isFlush)).toBe(false);
    expect(request.estimate).toBeLessThanOrEqual(8000 * CEILING);
  });

  it("memory.write: deny stores no memory during compression", async () => {
    b = bench(withBudget(8000, { permissions: { "memory.write": "deny" } }));
    for (let n = 0; n < 12; n++) round(b.store, "t1", n, [3000], { say: 2500 });
    b.model.respond = summarizer();
    await b.context.prepare(b.unit());
    expect(b.model.requests.some(isFlush)).toBe(false);
    expect(b.model.requests.some(isSummary)).toBe(true);
    expect(b.registry.calls).toEqual([]);
  });

  it("a chat turn's own user message is never summarised away within the turn", async () => {
    b = bench(withBudget(8000), { chat: true });
    for (let n = 0; n < 12; n++) round(b.store, "conversation", n, [3000], { say: 2500 });
    b.model.respond = summarizer();
    const request = await b.context.prepare(b.unit());
    expect(b.store.latestSummary("conversation")).toBeDefined();
    expect(request.messages.filter((m) => m.role === "user" && m.content === "hello")).toHaveLength(1);
  });

  it("a summary is forced after 200 unsummarised messages", async () => {
    b = bench(withBudget(1_000_000));
    for (let n = 0; n < 130; n++) round(b.store, "t1", n, [5]);
    b.model.respond = summarizer();
    await b.context.prepare(b.unit());
    const summary = b.store.latestSummary("t1")!;
    expect(b.store.countMessages("t1", summary.uptoMessageId)).toBeLessThanOrEqual(110);
  });
});
