/**
 * The `invisible-dots` command line client. `run` takes its arguments and
 * its world (output streams, stdin, environment, fetch) as parameters, so the
 * tests drive it in-process against a fake server.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, InvisibleDotsClient, type DotSummary, type TaskRecord } from "@invisible-dots/sdk";
import { hostPaths, type StoredEvent } from "@invisible-dots/shared";

export const CLI_VERSION = "0.1.0";
export const DEFAULT_URL = "http://127.0.0.1:8787";

/** Exit codes: what went wrong, for scripts. */
export const EXIT = {
  ok: 0,
  /** The server answered with an error (not found, conflict, invalid config...). */
  failed: 1,
  /** Wrong command line. */
  usage: 2,
  /** The server could not be reached. */
  unreachable: 3,
  /** No API token, or the server refused it. */
  auth: 4,
} as const;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** All of standard input, as text. */
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
  fetch?: typeof fetch;
  /** Aborted on Ctrl-C, to end `logs`. */
  signal?: AbortSignal;
}

class UsageError extends Error {}
class AuthSetupError extends Error {}

export const USAGE = `invisible-dots - control your Dots

Usage:
  invisible-dots init [file] [--force]          write a sample Dot config (default dot.yaml), check the server
  invisible-dots create <file.yaml>             create a Dot from a YAML config
  invisible-dots list                           list Dots
  invisible-dots status <dot>                   show a Dot, its computer and its recent tasks
  invisible-dots message <dot> <text...>        send a chat message
  invisible-dots task <dot> <description...> [--priority N] [--at ISO-8601]
                                                queue a task
  invisible-dots tasks <dot>                    list a Dot's tasks
  invisible-dots computer <dot> start|stop|reboot
  invisible-dots browser <dot> identities       list the Dot's browser identities
  invisible-dots approvals [--all]              list pending (or all) approvals
  invisible-dots approve <approval-id> [--note text]
  invisible-dots reject <approval-id> [--note text]
  invisible-dots secret openrouter [--dot <dot>]
                                                store the OpenRouter key, read from stdin (never from arguments)
  invisible-dots logs <dot> [--tail N] [--no-follow]
                                                print recent events, then follow new ones

<dot> is a Dot name or id. Add --json for machine-readable output.

Environment:
  INVISIBLE_DOTS_URL     server URL (default ${DEFAULT_URL})
  INVISIBLE_DOTS_TOKEN   API token (default: the first line of /etc/invisible-dots/api.token)

Exit codes: 0 ok, 1 the server reported an error, 2 usage error, 3 server unreachable, 4 missing or refused token.
`;

export const SAMPLE_DOT = `# A Dot configuration (docs/architecture.md, section 7).
name: my-first-dot                     # lowercase letters, digits and '-', up to 40
goal: >
  Keep a short daily summary of the front page of a news site in ~/workspace/news.md.
instructions: >
  Be concise. Write findings to files in ~/workspace.
model:
  provider: openrouter
  id: z-ai/glm-5.3-flash               # any OpenRouter model id
computer:
  cpu: 2
  memory: 4gb
  disk: 40gb
  idle_timeout: 15m                    # sleep after 15 minutes with nothing to do; 0 = never
browser:
  identities:
    managed_by_dot: true
    max_identities: 20
    max_open: 3
permissions:
  computer.exec: allow
  browser.identity.delete: ask
memory:
  enabled: true
limits:
  max_steps_per_task: 60
`;

const OPTIONS = {
  json: { type: "boolean" },
  force: { type: "boolean" },
  priority: { type: "string" },
  at: { type: "string" },
  note: { type: "string" },
  dot: { type: "string" },
  tail: { type: "string" },
  "no-follow": { type: "boolean" },
  all: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

async function resolveToken(env: Record<string, string | undefined>): Promise<string> {
  const fromEnv = env.INVISIBLE_DOTS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const path = hostPaths(env).apiToken;
  try {
    const token = (await readFile(path, "utf8")).split(/\r?\n/)[0]!.trim();
    if (token) return token;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new AuthSetupError(
      `no API token: set INVISIBLE_DOTS_TOKEN or make ${path} readable (${code === "EACCES" ? "permission denied: try sudo or join the right group" : code ?? "unreadable"})`,
    );
  }
  throw new AuthSetupError(`no API token: ${path} is empty; set INVISIBLE_DOTS_TOKEN`);
}

function need(args: string[], index: number, what: string): string {
  const value = args[index];
  if (value === undefined || value === "") throw new UsageError(`missing ${what}`);
  return value;
}

function pad(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n") + "\n";
}

function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

export function formatEvent(event: StoredEvent): string {
  const { guest_event_id: _id, guest_ts: _ts, ...data } = event.data;
  const detail = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
  return `${event.created_at} #${event.id} ${event.type}${detail}`;
}

function taskRows(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return "no tasks\n";
  return pad([
    ["ID", "STATUS", "PRIORITY", "CREATED", "DESCRIPTION"],
    ...tasks.map((t) => [t.id, t.status, String(t.priority), t.created_at, oneLine(t.description)]),
  ]);
}

function dotRows(dots: DotSummary[]): string {
  if (dots.length === 0) return "no Dots yet: create one with invisible-dots create <file.yaml>\n";
  return pad([
    ["NAME", "STATUS", "COMPUTER", "MODEL", "ID"],
    ...dots.map((d) => [d.name, d.status, d.computer_state ?? "-", d.config.model.id, d.id]),
  ]);
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`invisible-dots: ${(error as Error).message}\nRun "invisible-dots --help" for usage.\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${CLI_VERSION}\n`);
    return EXIT.ok;
  }
  const [command, ...args] = positionals;
  if (values.help || !command || command === "help") {
    io.stdout(USAGE);
    return command || values.help ? EXIT.ok : EXIT.usage;
  }

  const baseUrl = io.env.INVISIBLE_DOTS_URL?.trim() || DEFAULT_URL;
  const out = (value: unknown, text: string) => io.stdout(values.json ? `${JSON.stringify(value, null, 2)}\n` : text);
  let client: InvisibleDotsClient | undefined;
  const api = async () => {
    client ??= new InvisibleDotsClient({ baseUrl, token: await resolveToken(io.env), fetch: io.fetch });
    return client;
  };

  try {
    switch (command) {
      case "init": {
        const file = resolve(io.cwd, args[0] ?? "dot.yaml");
        try {
          await writeFile(file, SAMPLE_DOT, { flag: values.force ? "w" : "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            io.stderr(`invisible-dots: ${file} already exists; use --force to overwrite it\n`);
            return EXIT.failed;
          }
          throw error;
        }
        io.stdout(`wrote ${file}\n`);
        const health = await (await api()).health();
        io.stdout(`server ${baseUrl} is reachable (version ${health.version}, database ${health.database})\n`);
        io.stdout(`edit the file, then: invisible-dots create ${args[0] ?? "dot.yaml"}\n`);
        return EXIT.ok;
      }
      case "create": {
        const file = resolve(io.cwd, need(args, 0, "<file.yaml>"));
        let yaml: string;
        try {
          yaml = await readFile(file, "utf8");
        } catch (error) {
          throw new UsageError(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
        }
        const dot = await (await api()).createDot(yaml);
        out(dot, `created Dot ${dot.name} (${dot.id}); its computer is being provisioned.\nfollow it with: invisible-dots logs ${dot.name}\n`);
        return EXIT.ok;
      }
      case "list": {
        const dots = await (await api()).listDots();
        out(dots, dotRows(dots));
        return EXIT.ok;
      }
      case "status": {
        const name = need(args, 0, "<dot>");
        const c = await api();
        const [dot, computer, tasks] = await Promise.all([c.getDot(name), c.computer(name), c.listTasks(name)]);
        const text =
          pad([
            ["name", dot.name],
            ["id", dot.id],
            ["status", dot.status + (dot.error ? ` (${dot.error})` : "")],
            ["model", dot.config.model.id],
            ["goal", oneLine(dot.config.goal, 100)],
            ["computer", `${computer.state}${computer.ready ? ", ready" : ""}${computer.last_error ? ` (last error: ${computer.last_error})` : ""}`],
            ["resources", `${dot.config.computer.cpu} cpu, ${dot.config.computer.memory} memory, ${dot.config.computer.disk} disk, idle_timeout ${dot.config.computer.idle_timeout}`],
            ["last active", computer.last_active_at ?? "never"],
          ]) +
          "\n" +
          taskRows(tasks.slice(0, 10));
        out({ dot, computer, tasks }, text);
        return EXIT.ok;
      }
      case "message": {
        const name = need(args, 0, "<dot>");
        const text = args.slice(1).join(" ");
        if (!text.trim()) throw new UsageError("missing <text>");
        const answer = await (await api()).sendMessage(name, text);
        out(
          answer,
          answer.delivery === "delivered"
            ? `message delivered (${answer.message_id})\n`
            : `message queued (${answer.message_id}): the Dot's computer is starting and gets it once READY\n`,
        );
        return EXIT.ok;
      }
      case "task": {
        const name = need(args, 0, "<dot>");
        const description = args.slice(1).join(" ");
        if (!description.trim()) throw new UsageError("missing <description>");
        let priority: number | undefined;
        if (values.priority !== undefined) {
          priority = Number(values.priority);
          if (!Number.isInteger(priority)) throw new UsageError("--priority must be an integer");
        }
        if (values.at !== undefined && Number.isNaN(new Date(values.at).getTime())) {
          throw new UsageError("--at must be an ISO 8601 time, e.g. 2026-10-03T08:00:00Z");
        }
        const task = await (await api()).createTask(name, {
          description,
          ...(priority !== undefined ? { priority } : {}),
          ...(values.at !== undefined ? { scheduled_at: new Date(values.at).toISOString() } : {}),
        });
        out(task, `queued task ${task.id}\n`);
        return EXIT.ok;
      }
      case "tasks": {
        const tasks = await (await api()).listTasks(need(args, 0, "<dot>"));
        out(tasks, taskRows(tasks));
        return EXIT.ok;
      }
      case "computer": {
        const name = need(args, 0, "<dot>");
        const action = need(args, 1, "start|stop|reboot");
        const c = await api();
        if (action === "start") await c.startComputer(name);
        else if (action === "stop") await c.stopComputer(name);
        else if (action === "reboot") await c.rebootComputer(name);
        else throw new UsageError(`unknown computer action "${action}": use start, stop or reboot`);
        out({ accepted: true }, `${action} requested; follow it with: invisible-dots logs ${name}\n`);
        return EXIT.ok;
      }
      case "browser": {
        const name = need(args, 0, "<dot>");
        const what = need(args, 1, "identities");
        if (what !== "identities") throw new UsageError(`unknown browser subcommand "${what}": use identities`);
        const identities = await (await api()).listIdentities(name);
        out(
          identities,
          identities.length === 0
            ? "no browser identities\n"
            : pad([
                ["ID", "NAME", "STATUS", "LAST USED", "PROXY"],
                ...identities.map((i) => [i.id, i.name, i.status, i.lastUsedAt ?? "never", i.proxy ? "yes" : "-"]),
              ]),
        );
        return EXIT.ok;
      }
      case "approvals": {
        const approvals = await (await api()).listApprovals(values.all ? undefined : "pending");
        out(
          approvals,
          approvals.length === 0
            ? values.all
              ? "no approvals\n"
              : "no pending approvals\n"
            : pad([
                ["ID", "STATUS", "DOT", "TOOL", "REASON"],
                ...approvals.map((a) => [a.id, a.status, a.dot_id, a.tool, oneLine(a.reason)]),
              ]),
        );
        return EXIT.ok;
      }
      case "approve":
      case "reject": {
        const id = need(args, 0, "<approval-id>");
        const c = await api();
        const approval = command === "approve" ? await c.approve(id, values.note) : await c.reject(id, values.note);
        out(approval, `approval ${approval.id} ${approval.status}\n`);
        return EXIT.ok;
      }
      case "secret": {
        const kind = need(args, 0, "openrouter");
        if (kind !== "openrouter") throw new UsageError(`unknown secret "${kind}": only openrouter is supported`);
        if (args.length > 1) {
          throw new UsageError("the key is read from stdin, never from arguments (they end up in shell history and ps)");
        }
        if (io.stdinIsTTY) io.stderr("paste the OpenRouter API key, then press Enter and Ctrl-D:\n");
        const key = (await io.readStdin()).trim();
        if (!key) throw new UsageError("no key on stdin; e.g. invisible-dots secret openrouter < key.txt");
        if (/\s/.test(key)) throw new UsageError("the key on stdin contains whitespace; pass only the key");
        const result = await (await api()).setOpenRouterKey(key, values.dot);
        out(
          result,
          `OpenRouter key stored ${values.dot ? `for Dot ${values.dot}` : "for every Dot"}; pushed to ${result.pushed} running Dot${result.pushed === 1 ? "" : "s"}\n`,
        );
        return EXIT.ok;
      }
      case "logs": {
        const name = need(args, 0, "<dot>");
        const tail = values.tail === undefined ? 20 : Number(values.tail);
        if (!Number.isInteger(tail) || tail < 0) throw new UsageError("--tail must be a non-negative integer");
        const c = await api();
        const dot = await c.getDot(name).catch((error: unknown) => {
          // A deleted Dot's events stay readable by id.
          if (error instanceof ApiError && error.status === 404 && name.includes("_")) return { id: name };
          throw error;
        });
        let recent: StoredEvent[] = [];
        let after = 0;
        for (;;) {
          const page = await c.events(dot.id, { after, limit: 1000 });
          recent = [...recent, ...page].slice(-Math.max(tail, 1));
          if (page.length < 1000) break;
          after = page.at(-1)!.id;
        }
        const last = recent.at(-1)?.id ?? after;
        for (const event of tail === 0 ? [] : recent) io.stdout(values.json ? `${JSON.stringify(event)}\n` : `${formatEvent(event)}\n`);
        if (values["no-follow"]) return EXIT.ok;
        for await (const event of c.stream({
          dotId: dot.id,
          after: last,
          signal: io.signal,
          onReconnect: ({ error }) => io.stderr(`connection lost (${error.message}), reconnecting...\n`),
        })) {
          io.stdout(values.json ? `${JSON.stringify(event)}\n` : `${formatEvent(event)}\n`);
        }
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`invisible-dots: ${error.message}\nRun "invisible-dots --help" for usage.\n`);
      return EXIT.usage;
    }
    if (error instanceof AuthSetupError) {
      io.stderr(`invisible-dots: ${error.message}\n`);
      return EXIT.auth;
    }
    if (error instanceof ApiError) {
      if (error.status === 0) {
        io.stderr(`invisible-dots: ${error.message}\nIs invisible-dots-server running? Set INVISIBLE_DOTS_URL if it listens elsewhere.\n`);
        return EXIT.unreachable;
      }
      if (error.status === 401) {
        io.stderr(`invisible-dots: the server refused the API token (401); check INVISIBLE_DOTS_TOKEN or api.token\n`);
        return EXIT.auth;
      }
      io.stderr(`invisible-dots: ${error.message} [${error.status} ${error.code}]\n`);
      const details = error.details;
      if (Array.isArray(details)) {
        for (const issue of details as { path?: string; message?: string }[]) {
          io.stderr(`  ${issue.path ? `${issue.path}: ` : ""}${issue.message ?? ""}\n`);
        }
      }
      return EXIT.failed;
    }
    if (io.signal?.aborted) return EXIT.ok;
    io.stderr(`invisible-dots: ${(error as Error).message}\n`);
    return EXIT.failed;
  }
}
