/**
 * A stand-in for the control plane as the browser sees it: the routes the shell reads and the computer actions it
 * sends, answered from memory, and `/api/stream` as a live SSE body the test pushes events into. `install()` puts
 * it behind the global `fetch`, which is where the web client's SDK looks.
 */
import type { ApprovalRecord, ComputerAnswer, DotConfig, DotSummary, StoredEvent } from "@invisible-dots/shared/browser";
import { vi } from "vitest";

export function dotRecord(id: string, change: Partial<DotSummary> = {}): DotSummary {
  return {
    id,
    name: id,
    config: { goal: `the goal of ${id}` } as DotConfig,
    status: "READY",
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    computer_state: "RUNNING",
    ...change,
  };
}

export function approvalRecord(id: string, dotId: string, change: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id,
    dot_id: dotId,
    task_id: null,
    tool: "exec",
    permission: "computer.exec",
    arguments: {},
    reason: "needs a command",
    status: "pending",
    note: null,
    created_at: "2026-01-01T00:00:00Z",
    resolved_at: null,
    ...change,
  };
}

export class FakeControlPlane {
  dots: DotSummary[] = [];
  approvals: ApprovalRecord[] = [];
  /** Spend today, as `GET /api/dots/:id/usage` answers it. */
  spentUsd = 0;
  keyConfigured = true;
  healthy = true;
  computerLastError: string | null = null;
  /** Every request as "METHOD path", in order. */
  requests: string[] = [];
  /** Answer a computer action with this error status instead of 202. */
  failComputerAction: number | null = null;
  #stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  #nextEventId = 1;

  /** `fetch` as the browser would have it: the routes of this class and nothing else. */
  fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => this.#answer(String(input), init);

  install(): void {
    vi.stubGlobal("fetch", vi.fn(this.fetch));
  }

  /** Push a live event to everything listening on the stream. */
  push(dotId: string, type: string, data: Record<string, unknown> = {}): void {
    const event = { id: this.#nextEventId++, dot_id: dotId, type, data, source: "guest", guest_seq: null, created_at: new Date().toISOString() } as StoredEvent;
    this.#stream?.enqueue(new TextEncoder().encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`));
  }

  get streamOpen(): boolean {
    return this.#stream !== null;
  }

  async #answer(url: string, init?: RequestInit): Promise<Response> {
    const { pathname, searchParams } = new URL(url, "http://web.test");
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${pathname}`);
    const json = (body: unknown, status = 200) => Response.json(body, { status });

    if (pathname === "/api/stream") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.#stream = controller;
            init?.signal?.addEventListener("abort", () => {
              this.#stream = null;
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (pathname === "/session" && method === "DELETE") return new Response(null, { status: 204 });
    if (pathname === "/api/health") {
      return this.healthy ? json({ status: "ok", database: "ok", version: "9.9.9", openrouter_configured: this.keyConfigured }) : json({ error: "down", message: "down" }, 503);
    }
    if (pathname === "/api/dots") return json({ dots: this.dots });
    if (pathname === "/api/approvals") {
      const status = searchParams.get("status");
      return json({ approvals: this.approvals.filter((a) => !status || a.status === status) });
    }
    const dot = /^\/api\/dots\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if (dot) {
      const record = this.dots.find((d) => d.id === decodeURIComponent(dot[1]!));
      if (!record) return json({ error: "not_found", message: "no such Dot" }, 404);
      const rest = dot[2] ?? "";
      if (rest === "") return json(record);
      if (rest === "usage") return json({ dot_id: record.id, since: searchParams.get("since"), spent_usd: this.spentUsd });
      if (rest === "computer") {
        const answer: Partial<ComputerAnswer> = { dot_id: record.id, state: record.computer_state ?? "STOPPED", last_error: this.computerLastError, ready: true, system: null };
        return json(answer);
      }
      if (/^computer\/(start|stop|reboot)$/.test(rest) && method === "POST") {
        return this.failComputerAction ? json({ error: "refused", message: `the computer refused (${this.failComputerAction})` }, this.failComputerAction) : json({ accepted: true }, 202);
      }
    }
    return json({ error: "not_found", message: `${method} ${pathname}` }, 404);
  }
}
