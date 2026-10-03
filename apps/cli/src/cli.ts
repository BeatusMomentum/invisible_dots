/**
 * The `invisible-dots` command line. `run` takes its arguments and its world
 * (output streams, stdin, environment, fetch, the host commands) as
 * parameters, so the tests drive it in-process against a fake server and
 * fake host commands.
 *
 * Two kinds of command live here: the host commands of architecture
 * section 11 (setup, doctor, image build, server), which act on this
 * machine, and the API client commands, which talk to a running server.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, type DotSummary, type InvisibleDotsClient, type TaskRecord } from "@invisible-dots/sdk";
import { ENV, type StoredEvent } from "@invisible-dots/shared";
import { apiUrl, AuthSetupError, connectApi, DEFAULT_URL } from "./api-client.js";
import { STORE_OPENROUTER_KEY } from "./commands.js";
import { EXIT } from "./exit.js";

export { DEFAULT_URL } from "./api-client.js";
export { EXIT } from "./exit.js";

export const CLI_VERSION = "0.1.0";

/**
 * The commands that act on this host. The real ones (host.ts) load QEMU
 * discovery, the image builder and the whole control plane, so they are
 * imported only when one of them runs; tests pass fakes.
 */
export interface HostCommands {
  doctor(options: { json: boolean }, io: CliIo): Promise<number>;
  setup(io: CliIo): Promise<number>;
  imageBuild(io: CliIo): Promise<number>;
  server(io: CliIo): Promise<number>;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** All of standard input, as text: for input that is piped in. */
  readStdin: () => Promise<string>;
  /**
   * One line typed in the terminal. Enter ends it on every host; the
   * end-of-input key differs (Ctrl-D on Linux, Ctrl-Z then Enter on
   * Windows), so nothing a person types depends on it.
   */
  readLine: () => Promise<string>;
  stdinIsTTY: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
  fetch?: typeof fetch;
  /** Aborted on Ctrl-C, to end `logs` and stop `image build`. */
  signal?: AbortSignal;
  /** Default: the real host commands. */
  host?: HostCommands;
}

class UsageError extends Error {}

export const USAGE = `invisible-dots - control your Dots

Getting this host ready (the same four commands on Linux and Windows):
  invisible-dots setup                          get QEMU and its accelerator ready (may ask for administrator rights once)
  invisible-dots doctor [--json]                check everything; one line per check and the command that fixes a failure
  invisible-dots image build                    build the golden image and the runtime ISO
  invisible-dots server                         run the control plane in the foreground

Using the server:
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
                                                store the OpenRouter key: asked for in a terminal, read from stdin when piped (never from arguments)
  invisible-dots logs <dot> [--tail N] [--no-follow]
                                                print recent events, then follow new ones

<dot> is a Dot name or id. Add --json for machine-readable output.

Environment:
  ${ENV.HOME}       the data directory (default ~/.invisible-dots)
  ${ENV.QEMU_DIR}   the one directory QEMU is looked for in, when set (otherwise the official installer's directory, then PATH)
  ${ENV.URL}        server URL (default ${DEFAULT_URL})
  ${ENV.TOKEN}      API token (default: the first line of <${ENV.HOME}>/config/api.token)

Exit codes: 0 ok; 1 the server reported an error, a doctor check is not ok or a setup step failed;
2 usage error; 3 server unreachable; 4 missing or refused token; 5 restart the computer, then run doctor.
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
  context_tokens: 32000
  max_cost_per_task_usd: 1.00
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

/** The command word of an argument list, so main.ts can decide what Ctrl-C does before `run` starts. */
export function commandOf(argv: string[]): string | undefined {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false }).positionals[0];
  } catch {
    return undefined;
  }
}

function noArguments(args: string[], command: string): void {
  if (args.length > 0) throw new UsageError(`${command} takes no arguments, got "${args.join(" ")}"`);
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

  const baseUrl = apiUrl(io.env);
  const out = (value: unknown, text: string) => io.stdout(values.json ? `${JSON.stringify(value, null, 2)}\n` : text);
  let client: InvisibleDotsClient | undefined;
  const api = async () => (client ??= await connectApi(io.env, io.fetch));
  const host = async (): Promise<HostCommands> => io.host ?? (await import("./host.js")).realHostCommands();

  try {
    switch (command) {
      case "setup":
        noArguments(args, "setup");
        return await (await host()).setup(io);
      case "doctor":
        noArguments(args, "doctor");
        return await (await host()).doctor({ json: values.json === true }, io);
      case "image": {
        const what = need(args, 0, "build");
        if (what !== "build") throw new UsageError(`unknown image subcommand "${what}": use build`);
        noArguments(args.slice(1), "image build");
        return await (await host()).imageBuild(io);
      }
      case "server":
        noArguments(args, "server");
        return await (await host()).server(io);
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
        if (io.stdinIsTTY) io.stderr("paste the OpenRouter API key, then press Enter:\n");
        const key = (io.stdinIsTTY ? await io.readLine() : await io.readStdin()).trim();
        if (!key) throw new UsageError(`no key given; run "${STORE_OPENROUTER_KEY}" in a terminal and paste it, or pipe it in`);
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
        io.stderr(`invisible-dots: ${error.message}\nIs the server running (invisible-dots server)? Set ${ENV.URL} if it listens elsewhere.\n`);
        return EXIT.unreachable;
      }
      if (error.status === 401) {
        io.stderr(`invisible-dots: the server refused the API token (401); check ${ENV.TOKEN} or api.token\n`);
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
    // Ctrl-C is how `logs` ends; for every other command it is an interruption.
    if (io.signal?.aborted && command === "logs") return EXIT.ok;
    io.stderr(`invisible-dots: ${(error as Error).message}\n`);
    return EXIT.failed;
  }
}
