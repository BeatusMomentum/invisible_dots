/**
 * The end-to-end acceptance run of invisible_dots against real VMs on a real
 * accelerator (tests/e2e/README.md). It drives the product only from the
 * outside, the way a person does: the `invisible-dots` command and the HTTP
 * API of docs/architecture.md section 9.6, plus reads of the documented host
 * data directory (section 3.2). It imports nothing from the workspace, so a
 * product change cannot quietly change what this run checks.
 *
 * Run with plain Node 24 (type stripping), from the repository root, after
 * `npm ci`, the builds and the dot-agentd binary (README):
 *
 *   INVISIBLE_DOTS_HOME=<dir> E2E_OPENROUTER_KEY_FILE=<file> node tests/e2e/run.ts
 *
 * The OpenRouter key is read from E2E_OPENROUTER_KEY_FILE and only ever
 * written to the stdin of `invisible-dots secret openrouter`; it is never
 * printed, logged or passed on a command line. Steps k and m look for it in
 * every log, database row and file the run leaves.
 *
 * Every output file goes to E2E_LOG_DIR (default tmp/e2e/<UTC time>, which git
 * ignores): the CLI calls, the server's output, the image build, the
 * screenshots and summary.json with each step's result and duration.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Configuration

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const HOME = resolve(process.env.INVISIBLE_DOTS_HOME?.trim() || join(homedir(), ".invisible-dots"));
const LOG_DIR = resolve(process.env.E2E_LOG_DIR?.trim() || join(REPO, "tmp", "e2e", STAMP));
const CLI = resolve(process.env.E2E_CLI?.trim() || join(REPO, "apps", "cli", "dist", "invisible-dots.mjs"));
const KEY_FILE = process.env.E2E_OPENROUTER_KEY_FILE?.trim();
const API_URL = (process.env.INVISIBLE_DOTS_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, "");
const MODEL = process.env.E2E_MODEL?.trim() || "z-ai/glm-5.3-flash";
/** Dots this run creates are named with this prefix, so a later run can remove what a failed one left. */
const DOT_PREFIX = "e2e-";
const DOT_NAME = `${DOT_PREFIX}${STAMP.slice(4, 15).replace("T", "-").toLowerCase()}`;

const MINUTE = 60_000;
const TIMEOUTS = {
  cli: 2 * MINUTE,
  /** Downloads the cloud image and the browser engine and provisions a builder VM. */
  imageBuild: 90 * MINUTE,
  server: 2 * MINUTE,
  ready: 15 * MINUTE,
  task: 15 * MINUTE,
  stop: 3 * MINUTE,
  delete: 3 * MINUTE,
};

// Output

const env = { ...process.env, INVISIBLE_DOTS_HOME: HOME };
let cliLog: WriteStream | undefined;

function say(text: string): void {
  process.stdout.write(`${new Date().toISOString()} ${text}\n`);
}

class Failure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

// Processes

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One `invisible-dots` call. Its arguments and output go to cli.log; stdin
 * (only ever the key) does not. With `stream`, output is also appended to
 * that file as it arrives, for a long command whose progress is followed.
 */
async function cli(args: string[], options: { stdin?: string; timeoutMs?: number; stream?: string } = {}): Promise<CliResult> {
  const timeoutMs = options.timeoutMs ?? TIMEOUTS.cli;
  const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO, env, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const streamTo = options.stream ? createWriteStream(options.stream, { flags: "a" }) : undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    out.push(chunk);
    streamTo?.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err.push(chunk);
    streamTo?.write(chunk);
  });
  child.stdin.end(options.stdin ?? "");
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolveExit(exitCode));
  });
  clearTimeout(timer);
  streamTo?.end();
  const result = { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
  cliLog?.write(`$ invisible-dots ${args.join(" ")}\n${result.stdout}${result.stderr ? `[stderr]\n${result.stderr}` : ""}[exit ${code}]\n\n`);
  return result;
}

let server: ChildProcess | undefined;

async function startServer(): Promise<void> {
  const log = createWriteStream(join(LOG_DIR, "server.log"), { flags: "a" });
  server = spawn(process.execPath, [CLI, "server"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.pipe(log);
  server.stderr!.pipe(log);
  const started = Date.now();
  for (;;) {
    assert(server.exitCode === null, `invisible-dots server exited with ${server.exitCode}; see ${join(LOG_DIR, "server.log")}`);
    try {
      const health = await api<{ status: string; database: string }>("GET", "/api/health");
      if (health.status === "ok") return;
    } catch {
      // Not listening yet, or the token file is not written yet.
    }
    assert(Date.now() - started < TIMEOUTS.server, "the server did not answer /api/health in time");
    await sleep(500);
  }
}

/**
 * Stops the server the way a person does with Ctrl+C or a service manager.
 * On Linux SIGTERM runs the server's own shutdown (it closes the database and
 * releases server.lock); on Windows Node's kill() is TerminateProcess, so the
 * same call would test a hard kill instead. This run is written for Linux
 * hosts (README), where step h restarts the server gracefully.
 */
async function stopServer(): Promise<void> {
  const child = server;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  await exited;
  clearTimeout(timer);
}

// API

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiToken(): Promise<string> {
  const fromEnv = process.env.INVISIBLE_DOTS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return (await readFile(join(HOME, "config", "api.token"), "utf8")).split(/\r?\n/)[0]!.trim();
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${await apiToken()}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new HttpError(response.status, `${method} ${path}: ${response.status} ${await response.text()}`);
  return response;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await request(method, path, body);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

// The API's shapes, as section 9.6 and packages/shared/src/api.ts define them.
interface Dot {
  id: string;
  name: string;
  status: string;
  error: string | null;
  computer_state: string | null;
}
interface Computer {
  state: string;
  ready: boolean;
  pid: number | null;
  guest_port: number | null;
  last_error: string | null;
}
interface Task {
  id: string;
  status: string;
  summary: string | null;
  error: string | null;
}
interface StoredEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}
interface Identity {
  id: string;
  name: string;
  status: string;
  profilePath: string;
}
interface Approval {
  id: string;
  task_id: string | null;
  tool: string;
  status: string;
}
interface CheckResult {
  id: string;
  status: string;
  detail: string;
}

const enc = encodeURIComponent;

async function events(dotId: string, after = 0): Promise<StoredEvent[]> {
  const all: StoredEvent[] = [];
  for (;;) {
    const page = (await api<{ events: StoredEvent[] }>("GET", `/api/dots/${enc(dotId)}/events?after=${after}&limit=1000`)).events;
    all.push(...page);
    if (page.length < 1000) return all;
    after = page.at(-1)!.id;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Polls `probe` until it returns a value; `probe` throws a Failure to stop early. */
async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>, everyMs = 2000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    assert(Date.now() - started < timeoutMs, `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function waitReady(dotId: string): Promise<{ dot: Dot; computer: Computer }> {
  return waitFor("the Dot to be READY", TIMEOUTS.ready, async () => {
    const dot = await api<Dot>("GET", `/api/dots/${enc(dotId)}`);
    const computer = await api<Computer>("GET", `/api/dots/${enc(dotId)}/computer`);
    assert(dot.status !== "ERROR", `the Dot went to ERROR: ${dot.error ?? "(no error)"}; computer last_error: ${computer.last_error ?? "-"}`);
    return dot.status === "READY" && computer.ready ? { dot, computer } : undefined;
  }, 3000);
}

async function waitComputerState(dotId: string, state: string, timeoutMs: number): Promise<Computer> {
  return waitFor(`the computer to be ${state}`, timeoutMs, async () => {
    const computer = await api<Computer>("GET", `/api/dots/${enc(dotId)}/computer`);
    assert(!(computer.state === "ERROR" && state !== "ERROR"), `the computer went to ERROR: ${computer.last_error ?? "-"}`);
    return computer.state === state ? computer : undefined;
  });
}

/** Queues a task through the CLI and waits for it to end; a task that does not complete fails the step. */
async function runTask(dotName: string, description: string): Promise<Task> {
  const queued = await cli(["task", dotName, description, "--json"]);
  assert(queued.code === 0, `invisible-dots task failed (${queued.code}): ${queued.stderr.trim()}`);
  const task = JSON.parse(queued.stdout) as Task;
  return waitTask(task.id);
}

async function waitTask(taskId: string): Promise<Task> {
  const done = await waitFor(`task ${taskId} to end`, TIMEOUTS.task, async () => {
    const task = await api<Task>("GET", `/api/tasks/${enc(taskId)}`);
    return ["COMPLETED", "FAILED", "CANCELLED"].includes(task.status) ? task : undefined;
  }, 3000);
  assert(done.status === "COMPLETED", `task ${taskId} ended ${done.status}: ${done.error ?? done.summary ?? "(no detail)"}`);
  return done;
}

function taskEvents(all: StoredEvent[], taskId: string): StoredEvent[] {
  return all.filter((event) => event.data.task_id === taskId);
}

/** The `tool.called` events of one task for one tool that ran and succeeded. */
function toolOk(all: StoredEvent[], taskId: string, tool: string): boolean {
  return taskEvents(all, taskId).some((e) => e.type === "tool.called" && e.data.tool === tool && e.data.ok === true);
}

function describeTools(all: StoredEvent[], taskId: string): string {
  return taskEvents(all, taskId)
    .filter((e) => e.type === "tool.called")
    .map((e) => `${String(e.data.tool)}:${e.data.ok === true ? "ok" : "failed"}`)
    .join(", ");
}

async function sendMessage(dotName: string, text: string): Promise<string> {
  const sent = await cli(["message", dotName, text, "--json"]);
  assert(sent.code === 0, `invisible-dots message failed (${sent.code}): ${sent.stderr.trim()}`);
  return (JSON.parse(sent.stdout) as { message_id: string }).message_id;
}

async function waitReply(dotId: string, messageId: string): Promise<string> {
  return waitFor(`the reply to ${messageId}`, TIMEOUTS.task, async () => {
    const reply = (await events(dotId)).find((e) => e.type === "message.assistant" && e.data.in_reply_to === messageId);
    return reply ? String(reply.data.text ?? "") : undefined;
  }, 3000);
}

async function doctor(): Promise<{ code: number | null; checks: Map<string, CheckResult> }> {
  const result = await cli(["doctor", "--json"], { timeoutMs: 3 * MINUTE });
  const report = JSON.parse(result.stdout) as { ok: boolean; checks: CheckResult[] };
  return { code: result.code, checks: new Map(report.checks.map((check) => [check.id, check])) };
}

function expectChecks(checks: Map<string, CheckResult>, ids: string[]): void {
  for (const id of ids) {
    const check = checks.get(id);
    assert(check, `doctor has no "${id}" check`);
    assert(check.status === "ok", `doctor: ${id} is ${check.status}: ${check.detail}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Width and height from a PNG's IHDR chunk, after checking the signature. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  assert(buffer.length > 33 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "the screenshot is not a PNG");
  assert(buffer.toString("latin1", 12, 16) === "IHDR", "the PNG has no IHDR chunk first");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Whether `needle` occurs in the file, read in chunks: a Dot's overlay disk
 * is gigabytes, more than one Buffer holds. Each chunk is searched together
 * with the end of the previous one, so a match across a boundary is found.
 */
async function fileContains(path: string, needle: Buffer): Promise<boolean> {
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 2 ** 20 })) {
    const window = Buffer.concat([tail, chunk as Buffer]);
    if (window.includes(needle)) return true;
    tail = window.subarray(Math.max(0, window.length - (needle.length - 1)));
  }
  return false;
}

/** The files that hold the needle; a caller reports only where, never the needle. */
async function filesHolding(files: string[], needle: Buffer): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    if (await fileContains(file, needle)) found.push(file);
  }
  return found;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** How many rows (API answers) hold the needle in any field. */
function rowsHolding(rows: unknown[], needle: Buffer): number {
  return rows.filter((row) => Buffer.from(JSON.stringify(row), "utf8").includes(needle)).length;
}

/**
 * `invisible-dots computer stop`, then proof that it was the clean shutdown
 * of section 3.4: the guest took the poweroff and QEMU exited on its own
 * (`forced: false` on the computer.stopped event), well within the 60 s
 * after which the control plane kills it. A broken poweroff route would
 * still reach STOPPED, through the kill, and pass every other check here.
 * Returns how long the stop took, in seconds.
 */
async function stopComputer(dotId: string, pid: number): Promise<number> {
  const started = Date.now();
  const stopped = await cli(["computer", DOT_NAME, "stop"]);
  assert(stopped.code === 0, `invisible-dots computer stop exited with ${stopped.code}: ${stopped.stderr.trim()}`);
  await waitComputerState(dotId, "STOPPED", TIMEOUTS.stop);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  assert(!processAlive(pid), `QEMU pid ${pid} is still alive after STOPPED`);
  assert(!existsSync(join(HOME, "vms", dotId, "qemu.json")), "qemu.json is still there after STOPPED");
  const event = (await events(dotId)).filter((e) => e.type === "computer.stopped").at(-1);
  assert(event, "no computer.stopped event");
  assert(event.data.forced === false, `the stop was not clean: computer.stopped says ${JSON.stringify(event.data)}`);
  assert(seconds < 45, `the clean stop took ${seconds} s, close to the 60 s after which QEMU is killed`);
  return seconds;
}

// The run

interface StepResult {
  step: string;
  title: string;
  ok: boolean;
  seconds: number;
  detail: string;
}

const results: StepResult[] = [];

async function step(id: string, title: string, body: () => Promise<string>): Promise<void> {
  say(`step ${id}: ${title}`);
  const started = Date.now();
  try {
    const detail = await body();
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    results.push({ step: id, title, ok: true, seconds, detail });
    say(`step ${id}: PASS in ${seconds} s${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ step: id, title, ok: false, seconds, detail });
    say(`step ${id}: FAIL after ${seconds} s: ${detail}`);
    throw error;
  } finally {
    await saveEvents();
  }
}

/**
 * The Dot's whole event log as events.txt, one line per event, rewritten
 * after every step: the evidence of what the Dot did, kept even when a step
 * fails. Long strings are cut so the file stays readable.
 */
async function saveEvents(): Promise<void> {
  if (!state.dotId || !server || server.exitCode !== null) return;
  try {
    const lines = (await events(state.dotId)).map((event) => {
      const data = Object.fromEntries(
        Object.entries(event.data).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}...` : v]),
      );
      return `${event.created_at} #${event.id} ${event.type} ${JSON.stringify(data)}`;
    });
    await writeFile(join(LOG_DIR, "events.txt"), `${lines.join("\n")}\n`);
  } catch (error) {
    say(`could not save the event log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Shared between steps. */
const state: {
  dotId?: string;
  pid?: number;
  identity?: Identity;
  seedHash?: string;
  rememberedMessageId?: string;
} = {};

const PHRASE = "blue-harbor-42";
/** What every OpenRouter key starts with; step h searches the guest's journal for it. */
const KEY_PREFIX = "sk-or-";
/** The heading of https://example.com, which step e writes into heading.txt and remembers. */
const HEADING = "Example Domain";

function dotYaml(extraPermissions = ""): string {
  return [
    `name: ${DOT_NAME}`,
    "goal: >",
    "  Run the end-to-end acceptance checks of invisible_dots and do exactly what each task says.",
    "instructions: >",
    "  Follow each task literally. When asked to answer with only a value, answer with that value and nothing else.",
    "model:",
    "  provider: openrouter",
    `  id: ${MODEL}`,
    "computer:",
    "  cpu: 2",
    "  memory: 4gb",
    "  idle_timeout: 0",
    ...(extraPermissions ? ["permissions:", extraPermissions] : []),
    "",
  ].join("\n");
}

/**
 * Has the Dot run `command`, which ends by printing a sha256sum line, and
 * returns the hash it answers with. The model only relays a value it cannot
 * make up: every caller compares it with a hash computed on the host.
 */
async function hashTask(dotName: string, what: string, command: string): Promise<string> {
  const task = await runTask(dotName, `Run this exact command with the computer_exec tool: ${command}\nThen answer with only the 64-character hash it printed.`);
  const all = await events(state.dotId!);
  assert(toolOk(all, task.id, "computer_exec"), `the ${what} task did not run computer_exec successfully (tools: ${describeTools(all, task.id)})`);
  const hash = /\b[0-9a-f]{64}\b/.exec(task.summary ?? "")?.[0];
  assert(hash, `the ${what} task's answer holds no SHA-256: ${JSON.stringify(task.summary)}`);
  return hash;
}

async function seedHashTask(dotName: string, identity: Identity): Promise<string> {
  const file = `${identity.profilePath.replace(/\/+$/, "")}/.stealth-identity.json`;
  return hashTask(dotName, "seed hash", `sha256sum ${file}`);
}

/**
 * Proves a guest file holds exactly `expected`: the Dot hashes the file
 * inside the guest and the host compares that with the hash of the expected
 * text. Trailing newlines are left out of the comparison (`$(cat ...)` drops
 * them), because whether a model ends a file with one is not what is tested;
 * every other byte is.
 */
async function assertGuestFile(dotName: string, path: string, expected: string): Promise<void> {
  const hash = await hashTask(dotName, `${path} hash`, `printf '%s' "$(cat ${path})" | sha256sum`);
  assert(hash === sha256Text(expected), `${path} does not hold exactly ${JSON.stringify(expected)} (the guest hashed it to ${hash})`);
}

/**
 * Searches the guest's whole system journal for the key's prefix, inside the
 * guest, without giving the model any part of the key. The command fails
 * (and prints no hash) when the journal cannot be read: the kernel's own
 * entries, which only a reader of the system journal sees, must be there.
 * The answer is the hash of "<count> <nonce>", so only the command itself
 * can produce the value for a count of 0, and the model cannot guess it.
 * The pattern is written 'sk-o[r]-' so the journal line that records this
 * very command (the agent logs tool calls) does not match itself.
 */
async function assertJournalClean(dotName: string): Promise<void> {
  const nonce = randomBytes(8).toString("hex");
  const pattern = `${KEY_PREFIX.slice(0, 4)}[${KEY_PREFIX[4]}]${KEY_PREFIX.slice(5)}`;
  const command =
    `set -eu; j=$(mktemp); journalctl --no-pager -q -o export > "$j"; grep -aq '^_TRANSPORT=kernel$' "$j"; ` +
    `n=$(grep -ac '${pattern}' "$j" || true); rm -f "$j"; printf '%s %s' "$n" ${nonce} | sha256sum`;
  const hash = await hashTask(dotName, "journal", command);
  assert(hash === sha256Text(`0 ${nonce}`), "the guest journal holds the key's prefix, or the journal could not be read in full");
}

/**
 * Opens a page with an existing identity, which launches its browser again
 * on the profile already on disk: the launch the seed must survive (section 6).
 */
async function relaunchTask(dotName: string, identity: Identity, afterEventId: number): Promise<void> {
  const task = await runTask(
    dotName,
    `With the existing browser identity whose id is ${identity.id}, open https://example.com and answer with only the page title. Do not create a new identity.`,
  );
  const all = await events(state.dotId!);
  assert(toolOk(all, task.id, "browser_navigate"), `the relaunch task did not navigate (tools: ${describeTools(all, task.id)})`);
  const launched = all.some((e) => e.id > afterEventId && e.type === "browser.identity.launched" && e.data.identity_id === identity.id);
  assert(launched, `no browser.identity.launched event for ${identity.id} after the restart`);
}

/** What every guest request carries after `GET /v1/proof` (section 5.1). */
const GUEST_PROOF_CONTEXT = "invisible-dots guest proof v1\n";

/**
 * The Dot's own token, from its seed in the data directory. The seed is the
 * only place the host and this run can both read it; it is used only to reach
 * dot-agentd, and never printed.
 */
async function dotToken(dotId: string): Promise<string> {
  const seed = await readFile(join(HOME, "vms", dotId, "seed.iso"));
  // The seed's user-data carries the boot config as a JSON string, so its own quotes are escaped there.
  const match = /\\?"token\\?":\s*\\?"([A-Za-z0-9_-]{20,})\\?"/.exec(seed.toString("latin1"));
  assert(match, `could not read the Dot token from vms/${dotId}/seed.iso`);
  return match[1]!;
}

/**
 * Runs a command in the guest through dot-agentd's `POST /v1/exec`
 * (section 5.2), the way the control plane reaches the guest: the forwarded
 * port of the running computer, the proof handshake, and the Dot's own token.
 * This is how the run does to a guest what the model is not allowed to do to
 * its own computer, such as ending the agent process to check that systemd
 * brings it back and the engine resumes.
 */
async function guestExec(dotId: string, guestPort: number, command: string): Promise<{ exit_code: number; stdout: string; stderr: string; timed_out: boolean }> {
  const token = await dotToken(dotId);
  const base = `http://127.0.0.1:${guestPort}`;
  const nonce = randomBytes(16).toString("hex");
  const proofResponse = await fetch(`${base}/v1/proof?nonce=${nonce}`, { signal: AbortSignal.timeout(30_000) });
  assert(proofResponse.ok, `GET /v1/proof: ${proofResponse.status}`);
  const { proof } = (await proofResponse.json()) as { proof?: string };
  const expected = createHmac("sha256", token).update(`${GUEST_PROOF_CONTEXT}${nonce}`).digest("hex");
  assert(proof === expected, "dot-agentd did not prove it holds this Dot's token");
  const response = await fetch(`${base}/v1/exec`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, timeout_ms: 30_000 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`POST /v1/exec: ${response.status} ${await response.text()}`);
  return (await response.json()) as { exit_code: number; stdout: string; stderr: string; timed_out: boolean };
}

async function main(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  cliLog = createWriteStream(join(LOG_DIR, "cli.log"), { flags: "a" });
  assert(existsSync(CLI), `${CLI} does not exist: build it first (npm run build --workspace apps/cli)`);
  assert(KEY_FILE, "set E2E_OPENROUTER_KEY_FILE to a file holding the OpenRouter key");
  const key = (await readFile(KEY_FILE, "utf8")).trim();
  assert(key.length >= 20 && !/\s/.test(key), `${KEY_FILE} does not hold one OpenRouter key`);
  // Step h searches the guest's journal for this prefix; a key without it
  // would let that check pass without having looked for anything.
  assert(key.startsWith(KEY_PREFIX), `${KEY_FILE} does not hold an OpenRouter key: it does not start with ${KEY_PREFIX}`);
  say(`home ${HOME}, logs ${LOG_DIR}, Dot ${DOT_NAME}, model ${MODEL}`);

  await step("a", "doctor: accelerator and QEMU", async () => {
    const { checks } = await doctor();
    expectChecks(checks, ["node", "qemu", "qemu-img", "accelerator", "accelerator-probe"]);
    const accel = checks.get("accelerator-probe")!.detail;
    assert(/kvm/.test(accel), `the accelerator probe did not use kvm: ${accel}`);
    return `${checks.get("qemu")!.detail}; ${accel}`;
  });

  await step("b", "image build: golden image and runtime ISO", async () => {
    const buildLog = join(LOG_DIR, "image-build.log");
    say(`  progress: ${buildLog}`);
    const built = await cli(["image", "build"], { timeoutMs: TIMEOUTS.imageBuild, stream: buildLog });
    assert(built.code === 0, `invisible-dots image build exited with ${built.code}: ${built.stderr.trim().split("\n").slice(-5).join(" | ")}`);
    const imagesDir = join(HOME, "images");
    const names = (await readdir(imagesDir)).sort();
    const newest = (kind: string, ext: string) => names.filter((n) => n.startsWith(`${kind}-`) && n.endsWith(ext)).at(-1);
    const checked: string[] = [];
    for (const [kind, ext] of [["golden", ".qcow2"], ["runtime", ".iso"]] as const) {
      const image = newest(kind, ext);
      assert(image, `no ${kind} image in ${imagesDir}`);
      const manifestPath = join(imagesDir, image.slice(0, -ext.length) + ".json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { kind: string; file: string; sha256: string };
      assert(manifest.kind === kind && manifest.file === image, `${manifestPath} does not describe ${image}`);
      const actual = await sha256File(join(imagesDir, image));
      assert(actual === manifest.sha256, `${image} hashes to ${actual}, its manifest says ${manifest.sha256}`);
      checked.push(`${image} (${Math.round((await stat(join(imagesDir, image))).size / 2 ** 20)} MiB)`);
    }
    const { checks } = await doctor();
    expectChecks(checks, ["golden-image", "runtime-image"]);
    return checked.join(", ");
  });

  await step("c", "server in the background, OpenRouter key through the CLI", async () => {
    await startServer();
    // What an earlier failed run left: its Dots are removed so this run starts clean.
    const leftovers = (await api<{ dots: Dot[] }>("GET", "/api/dots")).dots.filter((d) => d.name.startsWith(DOT_PREFIX));
    for (const dot of leftovers) await api("DELETE", `/api/dots/${enc(dot.id)}`);
    for (const dot of leftovers) {
      await waitFor(`leftover Dot ${dot.name} to be deleted`, TIMEOUTS.delete, async () => {
        try {
          await api("GET", `/api/dots/${enc(dot.id)}`);
          return undefined;
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) return true;
          throw error;
        }
      });
    }
    const stored = await cli(["secret", "openrouter", "--json"], { stdin: `${key}\n` });
    assert(stored.code === 0, `invisible-dots secret openrouter exited with ${stored.code}: ${stored.stderr.trim()}`);
    const health = await api<{ openrouter_configured: boolean }>("GET", "/api/health");
    assert(health.openrouter_configured === true, "GET /api/health does not report the key as stored");
    return `server up; key stored${leftovers.length ? `; removed ${leftovers.length} leftover Dot(s)` : ""}`;
  });

  await step("d", "create a Dot from YAML, READY, doctor all ok", async () => {
    const file = join(LOG_DIR, "dot.yaml");
    await writeFile(file, dotYaml());
    const created = await cli(["create", file, "--json"]);
    assert(created.code === 0, `invisible-dots create exited with ${created.code}: ${created.stderr.trim()}`);
    const dot = JSON.parse(created.stdout) as Dot;
    state.dotId = dot.id;
    const { computer } = await waitReady(dot.id);
    assert(computer.state === "RUNNING" && computer.pid && computer.guest_port, `READY without a running QEMU: ${JSON.stringify(computer)}`);
    state.pid = computer.pid;
    const qemuJson = JSON.parse(await readFile(join(HOME, "vms", dot.id, "qemu.json"), "utf8")) as { pid: number; guest_port: number };
    assert(qemuJson.pid === computer.pid && qemuJson.guest_port === computer.guest_port, `qemu.json ${JSON.stringify(qemuJson)} disagrees with the computer record`);
    assert(processAlive(computer.pid), `QEMU pid ${computer.pid} is not alive`);
    const report = await doctor();
    expectChecks(report.checks, ["openrouter"]);
    assert(report.code === 0, `doctor exited with ${report.code} with everything in place`);
    state.rememberedMessageId = await sendMessage(DOT_NAME, `Remember this phrase for later in our conversation: ${PHRASE}. Do not use any tool. Reply with only OK.`);
    const reply = await waitReply(dot.id, state.rememberedMessageId);
    return `${dot.id} READY, QEMU pid ${computer.pid} on port ${computer.guest_port}; doctor all ok; chat reply ${JSON.stringify(reply.slice(0, 40))}`;
  });

  await step("e", "task: browser identity, example.com, file, memory", async () => {
    // example.com no longer has an <h1>: its markup is a title and one
    // paragraph, and a script adds more paragraphs. Without the parenthesis
    // the model has to guess what "heading" means and picks the title in
    // some runs and the first paragraph in others (measured), which would
    // make this step test the model's reading instead of the product.
    const task = await runTask(
      DOT_NAME,
      "Create a browser identity named research. With it, open https://example.com and read the page heading " +
        "(the page has no h1 element; its heading is the page title). " +
        "Then write the heading text, and nothing else, into ~/workspace/heading.txt with the file tool. " +
        "Finally remember under the key example-heading the heading text and nothing else.",
    );
    const all = await events(state.dotId!);
    const mine = taskEvents(all, task.id);
    const identityEvent = (type: string) => all.some((e) => e.type === type && e.data.name === "research");
    assert(identityEvent("browser.identity.created"), "no browser.identity.created event for research");
    assert(identityEvent("browser.identity.launched"), "no browser.identity.launched event for research");
    assert(toolOk(all, task.id, "browser_navigate"), `no successful browser_navigate (tools: ${describeTools(all, task.id)})`);
    assert(toolOk(all, task.id, "files_write"), `no successful files_write (tools: ${describeTools(all, task.id)})`);
    assert(all.some((e) => e.type === "memory.written" && e.data.key === "example-heading"), "no memory.written event for example-heading");
    assert(mine.some((e) => e.type === "task.completed"), "no task.completed event for the task");
    const identities = (await api<{ identities: Identity[] }>("GET", `/api/dots/${enc(state.dotId!)}/browser-identities`)).identities;
    const research = identities.find((i) => i.name === "research");
    assert(research, `GET browser-identities does not list research: ${JSON.stringify(identities.map((i) => i.name))}`);
    state.identity = research;
    await assertGuestFile(DOT_NAME, "~/workspace/heading.txt", HEADING);
    state.seedHash = await seedHashTask(DOT_NAME, research);
    return `identity ${research.id}; heading.txt holds exactly "${HEADING}" (by SHA-256); seed file sha256 ${state.seedHash.slice(0, 12)}...; tools: ${describeTools(all, task.id)}`;
  });

  await step("f", "screenshot through the API", async () => {
    const response = await request("GET", `/api/dots/${enc(state.dotId!)}/computer/screenshot`);
    assert(response.headers.get("content-type")?.startsWith("image/png"), `content-type ${response.headers.get("content-type")}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const { width, height } = pngSize(bytes);
    const file = join(LOG_DIR, "screenshot.png");
    await writeFile(file, bytes);
    return `${width}x${height}, ${bytes.byteLength} bytes, saved to ${file}`;
  });

  await step("g", "approval: files.write is ask, approve through the CLI", async () => {
    await api("PATCH", `/api/dots/${enc(state.dotId!)}`, { config: dotYaml("  files.write: ask") });
    const queued = await cli([
      "task",
      DOT_NAME,
      "Write the text approved-write, and nothing else, into ~/workspace/approval.txt with the files_write tool, then answer with only DONE.",
      "--json",
    ]);
    assert(queued.code === 0, `invisible-dots task failed (${queued.code}): ${queued.stderr.trim()}`);
    const taskId = (JSON.parse(queued.stdout) as Task).id;
    const approval = await waitFor("an approval request", TIMEOUTS.task, async () => {
      const task = await api<Task>("GET", `/api/tasks/${enc(taskId)}`);
      assert(!["COMPLETED", "FAILED", "CANCELLED"].includes(task.status), `the task ended ${task.status} without asking: ${task.summary ?? task.error}`);
      const pending = (await api<{ approvals: Approval[] }>("GET", "/api/approvals?status=pending")).approvals;
      return pending.find((a) => a.task_id === taskId);
    }, 3000);
    assert(approval.tool === "files_write", `the approval is for ${approval.tool}`);
    const before = await events(state.dotId!);
    assert(taskEvents(before, taskId).some((e) => e.type === "approval.requested"), "no approval.requested event");
    const waiting = await api<Task>("GET", `/api/tasks/${enc(taskId)}`);
    assert(waiting.status === "WAITING_APPROVAL", `the task is ${waiting.status} while its approval is pending`);
    const approved = await cli(["approve", approval.id, "--json"]);
    assert(approved.code === 0, `invisible-dots approve exited with ${approved.code}: ${approved.stderr.trim()}`);
    await waitTask(taskId);
    const all = await events(state.dotId!);
    assert(all.some((e) => e.type === "approval.resolved" && e.data.approval_id === approval.id), "no approval.resolved event");
    assert(toolOk(all, taskId, "files_write"), `the approved files_write did not succeed (tools: ${describeTools(all, taskId)})`);
    await assertGuestFile(DOT_NAME, "~/workspace/approval.txt", "approved-write");
    return `approval ${approval.id} approved; task ${taskId} COMPLETED; approval.txt holds exactly the approved text (by SHA-256)`;
  });

  await step("h", "stop, start, and everything is still there", async () => {
    const dotId = state.dotId!;
    const oldPid = state.pid!;

    // The control plane restarts without stopping Dots, and adopts the
    // running VM from its qemu.json (section 3.4, reconciliation).
    await stopServer();
    assert(processAlive(oldPid), `QEMU pid ${oldPid} exited with the server`);
    await startServer();
    const adopted = (await waitReady(dotId)).computer;
    assert(adopted.pid === oldPid, `after a server restart the computer names pid ${adopted.pid}, not the running ${oldPid}`);

    const stopSeconds = await stopComputer(dotId, oldPid);
    const started = await cli(["computer", DOT_NAME, "start"]);
    assert(started.code === 0, `invisible-dots computer start exited with ${started.code}: ${started.stderr.trim()}`);
    const { computer } = await waitReady(dotId);
    state.pid = computer.pid!;
    const restartedAt = Math.max(0, ...(await events(dotId)).map((e) => e.id));

    const identities = (await api<{ identities: Identity[] }>("GET", `/api/dots/${enc(dotId)}/browser-identities`)).identities;
    const research = identities.find((i) => i.name === "research");
    assert(research && research.id === state.identity!.id, `research is not the same identity after the restart: ${JSON.stringify(identities)}`);
    await relaunchTask(DOT_NAME, research, restartedAt);
    const seedHash = await seedHashTask(DOT_NAME, research);
    assert(seedHash === state.seedHash, `the identity's .stealth-identity.json changed: ${state.seedHash} -> ${seedHash}`);
    await assertGuestFile(DOT_NAME, "~/workspace/heading.txt", HEADING);

    // A memory has no file to hash: the model's answer is the only witness,
    // so it must be the remembered text and nothing else around it.
    const recall = await runTask(
      DOT_NAME,
      "Use the memory_search tool to look up example-heading and answer with only the text that memory holds, without quotes.",
    );
    const all = await events(dotId);
    assert(toolOk(all, recall.id, "memory_search"), `no successful memory_search (tools: ${describeTools(all, recall.id)})`);
    assert((recall.summary ?? "").trim().replace(/\.$/, "") === HEADING, `memory_search answer: ${JSON.stringify(recall.summary)}`);

    const history = (await api<{ messages: { role: string; text: string }[] }>("GET", `/api/dots/${enc(dotId)}/messages`)).messages;
    assert(history.some((m) => m.role === "user" && m.text.includes(PHRASE)), "the conversation lost the first message");
    // The host's event log keeps the conversation anyway; the guest's own
    // dot.db is what the model answers from.
    const asked = await sendMessage(DOT_NAME, "Which phrase did I ask you to remember earlier in this conversation? Do not use any tool. Reply with only the phrase.");
    const answer = await waitReply(dotId, asked);
    assert(answer.includes(PHRASE), `the Dot does not remember the conversation: ${JSON.stringify(answer)}`);

    // The guest's own logs, read inside the guest (journald compresses large
    // entries, which a scan of the disk from outside would miss).
    await assertJournalClean(DOT_NAME);
    return (
      `server restart adopted pid ${oldPid}; graceful stop in ${stopSeconds} s, STOPPED then READY (new pid ${computer.pid}); ` +
      "identity relaunched with the same seed file; heading.txt, memory and conversation kept; guest journal readable and without the key"
    );
  });

  await step("i", "the agent is restarted while an approval waits; the engine resumes", async () => {
    const dotId = state.dotId!;
    const computer = await api<Computer>("GET", `/api/dots/${enc(dotId)}/computer`);
    assert(computer.guest_port, "the computer has no guest port");
    const guestPort = computer.guest_port;
    const counter = "$HOME/workspace/approval-counter.txt";
    await guestExec(dotId, guestPort, `rm -f ${counter}`);
    await api("PATCH", `/api/dots/${enc(dotId)}`, { config: dotYaml("  computer.exec: ask") });
    const queued = await cli([
      "task",
      DOT_NAME,
      `Run this exact command with the computer_exec tool: printf x >> ~/workspace/approval-counter.txt\n` +
        "Then answer with only the note the user attached when approving the call, or NONE if there was none.",
      "--json",
    ]);
    assert(queued.code === 0, `invisible-dots task failed (${queued.code}): ${queued.stderr.trim()}`);
    const taskId = (JSON.parse(queued.stdout) as Task).id;
    const approval = await waitFor("an approval request", TIMEOUTS.task, async () => {
      const task = await api<Task>("GET", `/api/tasks/${enc(taskId)}`);
      assert(!["COMPLETED", "FAILED", "CANCELLED"].includes(task.status), `the task ended ${task.status} without asking: ${task.summary ?? task.error}`);
      return (await api<{ approvals: Approval[] }>("GET", "/api/approvals?status=pending")).approvals.find((a) => a.task_id === taskId);
    }, 3000);
    const startedBefore = (await events(dotId)).filter((e) => e.type === "agent.started").length;

    // End the agent process while it holds the approval; systemd (Restart=on-failure) starts it again.
    // The pattern is written so that it does not match the shell that runs it.
    await guestExec(dotId, guestPort, "pkill -9 -f 'invisible-dots-agent[.]mjs'; echo sent");
    await waitFor("agent.started from the restarted agent", TIMEOUTS.task, async () => {
      const started = (await events(dotId)).filter((e) => e.type === "agent.started").length;
      return started > startedBefore ? true : undefined;
    }, 2000);
    // The guest's own state, read through its socket: the same approval waits, and the host pushed the key again.
    const guestState = await waitFor("the restarted agent to hold the approval and the key", TIMEOUTS.task, async () => {
      const read = (path: string) => guestExec(dotId, guestPort, `curl -s --unix-socket /run/invisible-dots/agent.sock http://agent${path}`);
      const health = JSON.parse((await read("/health")).stdout || "{}") as { openrouter_configured?: boolean };
      const answer = JSON.parse((await read("/state")).stdout || "{}") as { pending_approval?: { approval_id: string } | null };
      return health.openrouter_configured === true && answer.pending_approval ? answer : undefined;
    }, 2000);
    assert(guestState.pending_approval!.approval_id === approval.id, `after the restart the guest waits on ${guestState.pending_approval!.approval_id}, not ${approval.id}`);

    const note = `once-${randomBytes(3).toString("hex")}`;
    const approved = await cli(["approve", approval.id, "--note", note, "--json"]);
    assert(approved.code === 0, `invisible-dots approve exited with ${approved.code}: ${approved.stderr.trim()}`);
    const done = await waitTask(taskId);
    // The tool ran exactly once, which the counter file proves.
    const count = await guestExec(dotId, guestPort, `wc -c < ${counter}`);
    assert(count.stdout.trim() === "1", `the approved command ran ${count.stdout.trim()} time(s), not once`);
    // The note followed the call's result into the model's next request: the model relays it.
    assert((done.summary ?? "").includes(note), `the note did not reach the model: the answer is ${JSON.stringify(done.summary)}`);
    return `agent restarted under systemd (agent.started seen); the guest still waited on ${approval.id} with the key pushed again; approved with a note, the command ran once and the note reached the model`;
  });

  await step("j", "the agent is restarted during a command; the interrupted call is reported", async () => {
    const dotId = state.dotId!;
    const computer = await api<Computer>("GET", `/api/dots/${enc(dotId)}/computer`);
    assert(computer.guest_port, "the computer has no guest port");
    const guestPort = computer.guest_port;
    await api("PATCH", `/api/dots/${enc(dotId)}`, { config: dotYaml() });
    const marker = "$HOME/workspace/exec-marker.txt";
    await guestExec(dotId, guestPort, `rm -f ${marker}`);
    // A command long enough that the restart lands while it runs; it appends one line, once.
    const queued = await cli([
      "task",
      DOT_NAME,
      "Run this exact command with the computer_exec tool: sleep 8; echo ran >> ~/workspace/exec-marker.txt\n" +
        "If the call is reported as interrupted, do not run it again: answer with only the word INTERRUPTED. Otherwise answer with only the word DONE.",
      "--json",
    ]);
    assert(queued.code === 0, `invisible-dots task failed (${queued.code}): ${queued.stderr.trim()}`);
    const taskId = (JSON.parse(queued.stdout) as Task).id;
    // Wait until the command is in flight (computer.exec is not replay-safe), then end the agent.
    // The brackets keep pgrep from matching the shell that runs it.
    await waitFor("the command to be in flight", TIMEOUTS.task, async () => {
      const task = await api<Task>("GET", `/api/tasks/${enc(taskId)}`);
      assert(!["COMPLETED", "FAILED", "CANCELLED"].includes(task.status), `the task ended ${task.status} before the command ran`);
      const probe = await guestExec(dotId, guestPort, "pgrep -f 'sleep [8]' >/dev/null && echo yes || echo no");
      return probe.stdout.trim() === "yes" ? true : undefined;
    }, 500);
    const inFlightAt = Date.now();
    await guestExec(dotId, guestPort, "pkill -9 -f 'invisible-dots-agent[.]mjs'; echo sent");
    const done = await waitTask(taskId);
    const all = await events(dotId);
    const calls = taskEvents(all, taskId).filter((e) => e.type === "tool.called" && e.data.tool === "computer_exec");
    assert(calls.some((e) => e.data.interrupted === true), `no interrupted computer_exec event for the task (tools: ${describeTools(all, taskId)})`);
    assert(calls.length === 1, `computer_exec was called ${calls.length} times in the task, not once (tools: ${describeTools(all, taskId)})`);
    // The command died with the agent that started it (dot-agentd kills a
    // command whose caller went away) and nothing ran it again: once its
    // 8 seconds are over, no sleep is left and the marker was never written.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, inFlightAt + 10_000 - Date.now())));
    const after = await guestExec(dotId, guestPort, `pgrep -f 'sleep [8]' >/dev/null && echo running || (wc -l < ${marker} 2>/dev/null || echo 0)`);
    assert(after.stdout.trim() === "0", `after the restart the command left "${after.stdout.trim()}", not 0 lines: it outlived its caller or ran again`);
    return `agent restarted during computer_exec; tool.called with interrupted: true for the call, which was not run again; the command died with its caller; the model answered ${JSON.stringify(done.summary)}`;
  });

  await step("k", "the key is in none of the Dot's own files and rows", async () => {
    const dotId = state.dotId!;
    const needle = Buffer.from(key.slice(0, 12), "utf8");
    // The database stores large jsonb values compressed (TOAST), so a key in
    // a long event would not show in its files (step m): the rows are read
    // back decompressed through the API, while the Dot's approvals still exist.
    const rows = [...(await events(dotId)), ...(await api<{ approvals: unknown[] }>("GET", "/api/approvals")).approvals];
    assert(rowsHolding(rows, needle) === 0, "found in an event or approval row of the database");
    // Stopped first, so the guest has flushed its disk and QEMU has closed
    // its files; scanned before step l deletes them.
    await stopComputer(dotId, state.pid!);
    await copyFile(join(HOME, "vms", dotId, "serial.log"), join(LOG_DIR, "serial.log")).catch(() => undefined);
    const files = [...(await filesUnder(join(HOME, "vms", dotId))), join(HOME, "logs", `qemu-${dotId}.log`)];
    // An empty or missing directory must not pass as "nothing found".
    for (const name of ["disk.qcow2", "seed.iso", "serial.log"]) {
      assert(files.includes(join(HOME, "vms", dotId, name)), `vms/${dotId}/${name} is not there to be scanned`);
    }
    assert(existsSync(join(HOME, "logs", `qemu-${dotId}.log`)), `logs/qemu-${dotId}.log is not there to be scanned`);
    const found = await filesHolding(files, needle);
    // Only "found" or "not found", and where: never the key or any part of it.
    assert(found.length === 0, `found in ${found.length} file(s): ${found.join(", ")}`);
    const bytes = (await Promise.all(files.map((file) => stat(file)))).reduce((sum, s) => sum + s.size, 0);
    return (
      `not found in ${rows.length} event and approval rows, nor in ${files.length} files of the stopped Dot ` +
      `(${Math.round(bytes / 2 ** 20)} MiB: its overlay disk, seed, serial log and QEMU log)`
    );
  });

  await step("l", "delete the Dot", async () => {
    const dotId = state.dotId!;
    const pid = state.pid!;
    await api("DELETE", `/api/dots/${enc(dotId)}`);
    await waitFor("the Dot to be gone", TIMEOUTS.delete, async () => {
      try {
        await api("GET", `/api/dots/${enc(dotId)}`);
        return undefined;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return true;
        throw error;
      }
    });
    await waitFor("the VM process to exit", 30_000, async () => (processAlive(pid) ? undefined : true), 500);
    assert(!existsSync(join(HOME, "vms", dotId)), `${join(HOME, "vms", dotId)} is still there`);
    const deleted = (await events(dotId)).some((e) => e.type === "dot.deleted");
    assert(deleted, "no dot.deleted event");
    return `pid ${pid} gone, vms/${dotId} removed`;
  });

  await step("m", "the key appears in no log and no database file", async () => {
    const needle = Buffer.from(key.slice(0, 12), "utf8");
    // Events outlive their Dot: read back once more, decompressed, after the delete.
    const rows = await events(state.dotId!);
    assert(rowsHolding(rows, needle) === 0, "found in an event row of the database");
    await stopServer();
    const scanned = [
      ...(await filesUnder(LOG_DIR)),
      ...(await filesUnder(join(HOME, "logs"))),
      // The embedded database's files, for whatever is stored uncompressed.
      ...(await filesUnder(join(HOME, "db"))),
    ];
    const found = await filesHolding(scanned, needle);
    // Only "found" or "not found", and where: never the key or any part of it.
    assert(found.length === 0, `found in ${found.length} file(s): ${found.join(", ")}`);
    return `not found in ${rows.length} event rows, nor in ${scanned.length} files (run logs, ${join(HOME, "logs")}, db)`;
  });
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  if (!(error instanceof Failure) && !results.some((r) => !r.ok)) say(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await stopServer().catch(() => undefined);
  cliLog?.end();
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(join(LOG_DIR, "summary.json"), `${JSON.stringify({ dot: DOT_NAME, model: MODEL, results }, null, 2)}\n`);
  for (const r of results) await appendFile(join(LOG_DIR, "summary.txt"), `${r.ok ? "PASS" : "FAIL"} ${r.step} ${r.seconds}s ${r.title}: ${r.detail}\n`);
  say(`${results.filter((r) => r.ok).length}/${results.length} steps passed; summary in ${join(LOG_DIR, "summary.json")}`);
}
process.exit(exitCode);
