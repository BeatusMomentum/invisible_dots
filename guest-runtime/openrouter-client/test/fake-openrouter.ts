/**
 * A local HTTP server that speaks enough of the OpenRouter chat.completions
 * API for tests: each request is answered by the next scripted reply, and every
 * request is recorded.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface ScriptedReply {
  status?: number;
  headers?: Record<string, string>;
  /** An object is sent as JSON, a string as is. */
  body: unknown;
  /** Wait this long before answering. */
  delayMs?: number;
}

export type Responder = (request: RecordedRequest, index: number) => ScriptedReply;

export interface FakeOpenRouter {
  url: string;
  requests: RecordedRequest[];
  /** Queue replies; once the queue is empty the fallback answers. */
  push(...replies: (ScriptedReply | Responder)[]): void;
  close(): Promise<void>;
}

export function completion(
  message: { content?: string | null; tool_calls?: { id: string; name: string; arguments: unknown }[] },
  usage: { prompt_tokens: number; completion_tokens: number; cost?: number } = { prompt_tokens: 10, completion_tokens: 5 },
): ScriptedReply {
  return {
    body: {
      id: `gen-${Math.random().toString(36).slice(2)}`,
      model: "test/model",
      choices: [
        {
          index: 0,
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: message.content ?? null,
            ...(message.tool_calls
              ? {
                  tool_calls: message.tool_calls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: {
                      name: c.name,
                      arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
                    },
                  })),
                }
              : {}),
          },
        },
      ],
      usage,
    },
  };
}

export async function startFakeOpenRouter(fallback?: Responder): Promise<FakeOpenRouter> {
  const queue: (ScriptedReply | Responder)[] = [];
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // keep the empty body; the test asserts on what it needs
      }
      const recorded: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(recorded);
      const next = queue.shift();
      const reply: ScriptedReply =
        next === undefined
          ? fallback
            ? fallback(recorded, requests.length - 1)
            : { status: 500, body: { error: { message: "fake server has no scripted reply left", code: 500 } } }
          : typeof next === "function"
            ? next(recorded, requests.length - 1)
            : next;
      const send = () => {
        const payload = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
        res.end(payload);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/v1/chat/completions`,
    requests,
    push: (...replies) => queue.push(...replies),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
