/**
 * A stand-in for the control plane as the browser sees it: the routes the shell reads and the computer actions it
 * sends, answered from memory, and `/api/stream` as a live SSE body the test pushes events into. `install()` puts
 * it behind the global `fetch`, which is where the web client's SDK looks.
 */
import type { ApprovalRecord, ComputerAnswer, DotConfig, DotSummary, StoredEvent } from "@invisible-dots/shared/browser";
import type { TaskRecord } from "@invisible-dots/sdk";
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

export function taskRecord(id: string, change: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    dot_id: "d1",
    description: `task ${id}`,
    priority: 0,
    status: "PENDING",
    created_at: "2026-01-01T00:00:00Z",
    scheduled_at: null,
    started_at: null,
    finished_at: null,
    summary: null,
    error: null,
    spent_usd: 0,
    ...change,
  };
}

export class FakeControlPlane {
  dots: DotSummary[] = [];
  approvals: ApprovalRecord[] = [];
  tasks: TaskRecord[] = [];
  /** The stored event log, as `GET /api/dots/:id/events` pages through it; `push` and `store` add to it. */
  events: StoredEvent[] = [];
  /** The body of every `POST /api/dots/:id/tasks`, as the browser sent it. */
  createdTasks: unknown[] = [];
  /** Answer `POST /api/dots/:id/tasks` with this error instead of 201. */
  failCreateTask: { status: number; error: string; message: string } | null = null;
  /** Answer `POST /api/tasks/:id/cancel` with this error instead of cancelling. */
  failCancel: { status: number; error: string; message: string } | null = null;
  /** The most events one `GET .../events` page holds (the real route's is 1000). */
  eventPage = 1000;
  /** Answer `GET .../events` with this status instead of the log. */
  failEvents: number | null = null;
  /** Spend today, as `GET /api/dots/:id/usage` answers it. */
  spentUsd = 0;
  keyConfigured = true;
  healthy = true;
  computerLastError: string | null = null;
  /** Every request as "METHOD path", in order. */
  requests: string[] = [];
  /** Answer a computer action with this error status instead of 202. */
  failComputerAction: number | null = null;
  /** The `config` of every `POST /api/dots`, as the browser sent it (YAML text or an object). */
  created: unknown[] = [];
  /** Answer `POST /api/dots` with this error instead of 201. */
  failCreate: { status: number; error: string; message: string; details?: unknown } | null = null;
  #stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  #nextEventId = 1;

  /** `fetch` as the browser would have it: the routes of this class and nothing else. */
  fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => this.#answer(String(input), init);

  install(): void {
    vi.stubGlobal("fetch", vi.fn(this.fetch));
  }

  /** Put an event in the stored log without telling the stream: it happened before the page opened. */
  store(dotId: string, type: string, data: Record<string, unknown> = {}, createdAt = new Date().toISOString()): StoredEvent {
    const event = { id: this.#nextEventId++, dot_id: dotId, type, data, source: "guest", guest_seq: null, created_at: createdAt } as StoredEvent;
    this.events.push(event);
    return event;
  }

  /** Push a live event to everything listening on the stream (it is stored too, as the real one is). */
  push(dotId: string, type: string, data: Record<string, unknown> = {}): void {
    const event = this.store(dotId, type, data);
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
    if (pathname === "/api/dots" && method === "POST") {
      const { config } = JSON.parse(String(init?.body)) as { config: unknown };
      this.created.push(config);
      if (this.failCreate) return json({ error: this.failCreate.error, message: this.failCreate.message, details: this.failCreate.details }, this.failCreate.status);
      return json(dotRecord("created-1", { name: "created", status: "CREATING", computer_state: null }), 201);
    }
    if (pathname === "/api/dots") return json({ dots: this.dots });
    if (pathname === "/api/approvals") {
      const status = searchParams.get("status");
      return json({ approvals: this.approvals.filter((a) => !status || a.status === status) });
    }
    const task = /^\/api\/tasks\/([^/]+)(\/cancel)?$/.exec(pathname);
    if (task) {
      const record = this.tasks.find((t) => t.id === decodeURIComponent(task[1]!));
      if (!record) return json({ error: "not_found", message: "no such task" }, 404);
      if (!task[2]) return json(record);
      if (this.failCancel) return json({ error: this.failCancel.error, message: this.failCancel.message }, this.failCancel.status);
      Object.assign(record, { status: "CANCELLED", error: "cancelled by the user", finished_at: new Date().toISOString() });
      return json(record);
    }
    const dot = /^\/api\/dots\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if (dot) {
      const record = this.dots.find((d) => d.id === decodeURIComponent(dot[1]!));
      if (!record) return json({ error: "not_found", message: "no such Dot" }, 404);
      const rest = dot[2] ?? "";
      if (rest === "") return json(record);
      if (rest === "tasks" && method === "GET") return json({ tasks: this.tasks.filter((t) => t.dot_id === record.id) });
      if (rest === "tasks" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { description: string; priority?: number; scheduled_at?: string };
        this.createdTasks.push(body);
        if (this.failCreateTask) return json({ error: this.failCreateTask.error, message: this.failCreateTask.message }, this.failCreateTask.status);
        const created = taskRecord(`created-${this.createdTasks.length}`, {
          dot_id: record.id,
          description: body.description,
          priority: body.priority ?? 0,
          scheduled_at: body.scheduled_at ?? null,
          created_at: new Date().toISOString(),
        });
        this.tasks.push(created);
        return json(created, 201);
      }
      if (rest === "events") {
        if (this.failEvents) return json({ error: "broken", message: "the event log is not available" }, this.failEvents);
        const after = Number(searchParams.get("after") ?? 0);
        const limit = Math.min(Number(searchParams.get("limit") ?? 500), this.eventPage);
        return json({ events: this.events.filter((e) => e.dot_id === record.id && e.id > after).slice(0, limit) });
      }
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
