import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OpenRouterAuthError,
  OpenRouterClient,
  OpenRouterCreditsError,
  OpenRouterError,
  OpenRouterNotConfiguredError,
  OpenRouterRateLimitError,
  UsageAccumulator,
  imagePart,
  parseRetryAfter,
  toFunctionTools,
} from "../src/index.js";
import { getTool, OPENROUTER_REFERER, OPENROUTER_TITLE } from "@invisible-dots/shared";
import { completion, startFakeOpenRouter, type FakeOpenRouter } from "./fake-openrouter.js";

let fake: FakeOpenRouter;
let sleeps: number[];

function client(extra: Partial<ConstructorParameters<typeof OpenRouterClient>[0]> = {}) {
  return new OpenRouterClient({
    apiKey: "test-key",
    url: fake.url,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
}

beforeEach(async () => {
  fake = await startFakeOpenRouter();
  sleeps = [];
});

afterEach(async () => {
  await fake.close();
});

describe("OpenRouterClient", () => {
  it("sends the contract headers, the model, the tools and tool_choice auto without streaming", async () => {
    fake.push(completion({ content: "hello" }, { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 }));
    const tools = toFunctionTools([getTool("files_read")!]);
    const result = await client().chat({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }], tools });

    expect(result.text).toBe("hello");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 });
    expect(result.attempts).toBe(1);

    const sent = fake.requests[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.headers.authorization).toBe("Bearer test-key");
    expect(sent.headers["http-referer"]).toBe(OPENROUTER_REFERER);
    expect(sent.headers["x-title"]).toBe(OPENROUTER_TITLE);
    expect(sent.body.model).toBe("z-ai/glm-5.3-flash");
    expect(sent.body.stream).toBe(false);
    expect(sent.body.tool_choice).toBe("auto");
    expect((sent.body.tools as { function: { name: string } }[])[0]!.function.name).toBe("files_read");
  });

  it("omits tool_choice when no tools are offered", async () => {
    fake.push(completion({ content: "ok" }));
    await client().chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(fake.requests[0]!.body.tool_choice).toBeUndefined();
  });

  it("parses tool calls and reports undecodable arguments instead of throwing", async () => {
    fake.push(
      completion({
        content: null,
        tool_calls: [
          { id: "c1", name: "files_read", arguments: { path: "a.txt" } },
          { id: "c2", name: "files_list", arguments: "{not json" },
          { id: "c3", name: "computer_screenshot", arguments: "" },
          { id: "c4", name: "files_read", arguments: "[1,2]" },
        ],
      }),
    );
    const result = await client().chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(result.message.tool_calls).toHaveLength(4);
    expect(result.toolCalls[0]).toMatchObject({ id: "c1", name: "files_read", arguments: { path: "a.txt" } });
    expect(result.toolCalls[1]).toMatchObject({ id: "c2", arguments: null, argumentsError: "the arguments are not valid JSON" });
    expect(result.toolCalls[2]).toMatchObject({ id: "c3", arguments: {} });
    expect(result.toolCalls[3]!.argumentsError).toBe("the arguments must be a JSON object");
    expect(result.text).toBe("");
  });

  it("sends image parts as data URLs", async () => {
    fake.push(completion({ content: "a cat" }));
    await client().chat({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "what is it" }, imagePart("image/png", "AAAA")] }],
    });
    const messages = fake.requests[0]!.body.messages as { content: { type: string; image_url?: { url: string } }[] }[];
    expect(messages[0]!.content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  it("retries 429 honouring Retry-After in seconds, then succeeds", async () => {
    fake.push(
      { status: 429, headers: { "retry-after": "3" }, body: { error: { message: "slow down", code: 429 } } },
      completion({ content: "done" }),
    );
    const result = await client().chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(result.text).toBe("done");
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([3000]);
  });

  it("backs off exponentially on 5xx and gives up after 4 attempts", async () => {
    for (let i = 0; i < 4; i++) fake.push({ status: 502, body: { error: { message: "upstream down", code: 502 } } });
    const error = await client({ baseDelayMs: 100 })
      .chat({ model: "m", messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect((error as OpenRouterError).code).toBe("server_error");
    expect((error as OpenRouterError).message).toContain("upstream down");
    expect(fake.requests).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("caps a Retry-After that asks for too long a wait", async () => {
    fake.push({ status: 503, headers: { "retry-after": "3600" }, body: "" }, completion({ content: "ok" }));
    await client({ maxDelayMs: 5000 }).chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(sleeps).toEqual([5000]);
  });

  it("raises a rate limit error once the retries are exhausted", async () => {
    for (let i = 0; i < 4; i++) fake.push({ status: 429, body: { error: { message: "limit", code: 429 } } });
    const error = await client().chat({ model: "m", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterRateLimitError);
    expect((error as OpenRouterError).status).toBe(429);
  });

  it("does not retry 401 and says the key is bad", async () => {
    fake.push({ status: 401, body: { error: { message: "No auth credentials found", code: 401 } } });
    const error = await client().chat({ model: "m", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterAuthError);
    expect((error as OpenRouterError).code).toBe("bad_key");
    expect((error as Error).message).toContain("No auth credentials found");
    expect(fake.requests).toHaveLength(1);
  });

  it("does not retry 402 and says the credits ran out", async () => {
    fake.push({ status: 402, body: { error: { message: "Insufficient credits", code: 402 } } });
    const error = await client().chat({ model: "m", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterCreditsError);
    expect((error as OpenRouterError).code).toBe("insufficient_credits");
    expect(fake.requests).toHaveLength(1);
  });

  it("does not retry other 4xx", async () => {
    fake.push({ status: 400, body: { error: { message: "model not found", code: 400 } } });
    const error = await client().chat({ model: "m", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect((error as OpenRouterError).code).toBe("bad_request");
    expect(fake.requests).toHaveLength(1);
  });

  it("treats a 200 that carries an error object as that error", async () => {
    fake.push({ body: { error: { message: "provider overloaded", code: 503 } } }, completion({ content: "fine" }));
    const result = await client().chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(result.text).toBe("fine");
    expect(result.attempts).toBe(2);
  });

  it("retries an answer without choices", async () => {
    fake.push({ body: { id: "x", choices: [] } }, completion({ content: "fine" }));
    const result = await client().chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(result.attempts).toBe(2);
  });

  it("refuses to call OpenRouter before a key is set, and works after setApiKey", async () => {
    const c = new OpenRouterClient({ url: fake.url });
    expect(c.configured).toBe(false);
    await expect(c.chat({ model: "m", messages: [] })).rejects.toBeInstanceOf(OpenRouterNotConfiguredError);
    expect(fake.requests).toHaveLength(0);
    c.setApiKey("later-key");
    expect(c.configured).toBe(true);
    fake.push(completion({ content: "ok" }));
    await c.chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(fake.requests[0]!.headers.authorization).toBe("Bearer later-key");
  });

  it("reports a network failure as retryable and gives up after the attempts", async () => {
    await fake.close();
    const error = await new OpenRouterClient({ apiKey: "k", url: fake.url, sleep: async () => {} })
      .chat({ model: "m", messages: [] })
      .catch((e: unknown) => e);
    expect((error as OpenRouterError).code).toBe("network_error");
    expect((error as OpenRouterError).retryable).toBe(true);
    fake = await startFakeOpenRouter();
  });

  it("times out a slow attempt", async () => {
    fake.push({ body: completion({ content: "late" }).body, delayMs: 500 }, completion({ content: "fast" }));
    const result = await client({ timeoutMs: 100 }).chat({ model: "m", messages: [] });
    expect(result.text).toBe("fast");
    expect(result.attempts).toBe(2);
  });

  it("stops when the caller aborts", async () => {
    // Held until the end: the abort comes while the request is surely in flight, on a loaded machine too.
    let release!: () => void;
    fake.push({ body: completion({ content: "late" }).body, hold: new Promise<void>((resolve) => (release = resolve)) });
    const controller = new AbortController();
    void fake.waitForRequests(1).then(() => controller.abort());
    const error = await client().chat({ model: "m", messages: [] }, { signal: controller.signal }).catch((e: unknown) => e);
    release();
    expect((error as OpenRouterError).code).toBe("aborted");
    expect(fake.requests).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("parses Retry-After as seconds or as an HTTP date", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 00:00:05 GMT", now)).toBe(0);
  });

  it("accumulates usage and keeps cost null until one is reported", () => {
    const usage = new UsageAccumulator();
    usage.add({ prompt_tokens: 10, completion_tokens: 2 });
    expect(usage.toJSON()).toEqual({ prompt_tokens: 10, completion_tokens: 2, cost: null, requests: 1 });
    usage.add({ prompt_tokens: 5, completion_tokens: 1, cost: 0.25 });
    usage.add({ prompt_tokens: 1, completion_tokens: 1, cost: 0.5 });
    expect(usage.toJSON()).toEqual({ prompt_tokens: 16, completion_tokens: 4, cost: 0.75, requests: 3 });
    expect(new UsageAccumulator(usage.toJSON()).toJSON()).toEqual(usage.toJSON());
  });
});
