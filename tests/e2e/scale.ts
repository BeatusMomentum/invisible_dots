/**
 * Many Dots on one host (tests/e2e/README.md, "The scale run"): how the product holds up as the Dots that
 * run at once grow, on real VMs, driven from the outside like run.ts.
 *
 * For each level of N Dots (default 1, 2, 4, 8) it creates N Dots at once, waits for every one to be
 * READY, sends each a chat message, gives each a task that runs a command in its computer, reads the
 * result back from the guest, and deletes them all. All along it samples the API's /api/health and
 * /api/dots, the host's available memory and the QEMU processes' memory. A level passes when every Dot
 * came up, answered and did its task, and the budgets hold:
 * - the API answers within SCALE_HEALTH_P95_MS (default 500 ms) at the 95th percentile;
 * - the time to READY, to a reply and to a task's end stays within SCALE_RATIO (default 3) times the same
 *   time with one Dot, plus 30 s (a ratio, so the budget is about the host's sharing, not its speed);
 * - the host keeps SCALE_MIN_FREE_MB (default 1024) of memory available.
 *
 *   INVISIBLE_DOTS_HOME=<dir> E2E_OPENROUTER_KEY_FILE=<file> node tests/e2e/scale.ts [--levels 1,2,4,8]
 *
 * It needs what run.ts needs, and the images run.ts step b builds in the same home. Its Dots are named
 * scale-...; one a failed run left is removed at the start. The results go to E2E_LOG_DIR (default
 * tmp/scale/<UTC time>): summary.json and summary.txt, the samples, the CLI calls and the server's log.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MINUTE, Product, say, sleep, waitFor } from "./driver.ts";
import { assert, dotYaml, Failure, keyFromFile, ROUTES, route, utcStamp, type Dot, type StoredEvent, type Task } from "./lib.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAMP = utcStamp(new Date());
const HOME = resolve(process.env.INVISIBLE_DOTS_HOME?.trim() || join(homedir(), ".invisible-dots"));
const LOG_DIR = resolve(process.env.E2E_LOG_DIR?.trim() || join(REPO, "tmp", "scale", STAMP));
const CLI = resolve(process.env.E2E_CLI?.trim() || join(REPO, "apps", "cli", "dist", "invisible-dots.mjs"));
const KEY_FILE = process.env.E2E_OPENROUTER_KEY_FILE?.trim();
const API_URL = (process.env.INVISIBLE_DOTS_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, "");
const MODEL = process.env.E2E_MODEL?.trim() || "z-ai/glm-5.3-flash";
const levelsArg = process.argv.indexOf("--levels");
const LEVELS = (levelsArg > 0 ? process.argv[levelsArg + 1]! : "1,2,4,8").split(",").map(Number);
const HEALTH_P95_MS = Number(process.env.SCALE_HEALTH_P95_MS ?? 500);
const RATIO = Number(process.env.SCALE_RATIO ?? 3);
const MIN_FREE_MB = Number(process.env.SCALE_MIN_FREE_MB ?? 1024);
const SLACK_MS = 30_000;
const PREFIX = "scale-";
const COMPUTER = { cpu: 1, memory: process.env.SCALE_MEMORY?.trim() || "2gb" };

const product = new Product({
  repo: REPO,
  home: HOME,
  logDir: LOG_DIR,
  cli: CLI,
  apiUrl: API_URL,
  webUrl: "",
  web: false,
  timeouts: { cli: 2 * MINUTE, server: 2 * MINUTE, ready: 20 * MINUTE, task: 20 * MINUTE, delete: 5 * MINUTE },
});
const { api, cli, events, guestExec, request, startServer, stopServer, waitDeleted, waitReady, waitTask } = product;

// Samples

interface Sample {
  at: number;
  what: string;
  ms: number;
  ok: boolean;
}

const samples: Sample[] = [];
const host: { at: number; availableMb: number; qemuRssMb: number; qemus: number }[] = [];
let sampling = true;

async function timed<T>(what: string, call: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const value = await call();
    samples.push({ at: Date.now(), what, ms: performance.now() - started, ok: true });
    return value;
  } catch (error) {
    samples.push({ at: Date.now(), what, ms: performance.now() - started, ok: false });
    throw error;
  }
}

/** The API, asked what a page asks all the time, four times a second. */
async function sampleApi(): Promise<void> {
  while (sampling) {
    await timed("health", () => api("GET", ROUTES.health)).catch(() => undefined);
    await timed("dots", () => api("GET", ROUTES.dots)).catch(() => undefined);
    await sleep(250);
  }
}

/** The host's available memory and the QEMU processes' resident memory, every two seconds (Linux /proc). */
async function sampleHost(): Promise<void> {
  while (sampling) {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const availableKb = Number(/^MemAvailable:\s+(\d+)/m.exec(meminfo)?.[1] ?? 0);
    let rssKb = 0;
    let qemus = 0;
    for (const pid of await readdir("/proc").catch(() => [])) {
      if (!/^\d+$/.test(pid)) continue;
      const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
      if (!/^Name:\s+qemu-system/m.test(status)) continue;
      qemus++;
      rssKb += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    }
    host.push({ at: Date.now(), availableMb: Math.round(availableKb / 1024), qemuRssMb: Math.round(rssKb / 1024), qemus });
    await sleep(2000);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const round = (ms: number) => Math.round(ms);

// One level

interface LevelResult {
  dots: number;
  ok: boolean;
  problems: string[];
  readyMs: number[];
  replyMs: number[];
  taskMs: number[];
  deleteMs: number[];
  apiP95Ms: number;
  apiErrors: number;
  minAvailableMb: number;
  maxQemuRssMb: number;
}

async function waitReply(dotId: string, messageId: string): Promise<StoredEvent> {
  return waitFor(`the reply to ${messageId}`, 20 * MINUTE, async () => {
    return (await events(dotId)).find((e) => e.type === "message.assistant" && e.data.in_reply_to === messageId);
  }, 2000);
}

/** Runs every promise to its end; the failures become the level's problems, named by what failed. */
async function all<T>(what: string, calls: (() => Promise<T>)[], problems: string[]): Promise<(T | undefined)[]> {
  const settled = await Promise.allSettled(calls.map((call) => call()));
  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    problems.push(`${what} ${i + 1}: ${(result.reason as Error).message}`);
    return undefined;
  });
}

async function level(n: number): Promise<LevelResult> {
  const problems: string[] = [];
  const from = Date.now();
  const names = Array.from({ length: n }, (_, i) => `${PREFIX}${n}-${i + 1}-${STAMP.slice(9, 15).toLowerCase()}`);

  const ready = await all("ready", names.map((name) => async () => {
    const started = performance.now();
    const dot = await api<Dot>("POST", ROUTES.dots, { config: dotYaml({ name, model: MODEL, computer: COMPUTER }) });
    await waitReady(dot.id);
    return { dot, ms: performance.now() - started };
  }), problems);
  const up = ready.filter((r) => r !== undefined);
  say(`level ${n}: ${up.length}/${n} READY`);

  const replies = await all("reply", up.map(({ dot }) => async () => {
    const started = performance.now();
    // 202 with the message's id: the answer comes later, as an event.
    const sent = (await (await request("POST", route(ROUTES.messages, { id: dot.id }), { text: "Answer with only the word PONG." })).json()) as { message_id: string };
    const reply = await waitReply(dot.id, sent.message_id);
    assert(/pong/i.test(String(reply.data.text)), `${dot.name} answered ${JSON.stringify(reply.data.text)}`);
    return performance.now() - started;
  }), problems);
  say(`level ${n}: ${replies.filter((r) => r !== undefined).length}/${up.length} replies`);

  const tasks = await all("task", up.map(({ dot }, i) => async () => {
    const started = performance.now();
    const marker = `scale-${n}-${i + 1}`;
    const task = await api<Task>("POST", route(ROUTES.tasks, { id: dot.id }), {
      description: `Run the command \`echo ${marker} > /home/dot/workspace/scale.txt\` with the exec tool, then answer with only DONE.`,
    });
    await waitTask(task.id);
    const read = await guestExec(dot.id, "cat /home/dot/workspace/scale.txt");
    assert(read.stdout.trim() === marker, `${dot.name}'s scale.txt holds ${JSON.stringify(read.stdout.trim())}`);
    return performance.now() - started;
  }), problems);
  say(`level ${n}: ${tasks.filter((t) => t !== undefined).length}/${up.length} tasks`);

  const deleted = await all("delete", up.map(({ dot }) => async () => {
    const started = performance.now();
    await api("DELETE", route(ROUTES.dot, { id: dot.id }));
    await waitDeleted(dot.id, `${dot.name} to be deleted`);
    return performance.now() - started;
  }), problems);

  const during = samples.filter((s) => s.at >= from);
  const hostDuring = host.filter((h) => h.at >= from);
  const done = (values: (number | undefined)[]) => values.filter((v): v is number => v !== undefined).map(round);
  return {
    dots: n,
    ok: problems.length === 0,
    problems,
    readyMs: up.map((r) => round(r.ms)),
    replyMs: done(replies),
    taskMs: done(tasks),
    deleteMs: done(deleted),
    apiP95Ms: round(percentile(during.filter((s) => s.ok).map((s) => s.ms), 95)),
    apiErrors: during.filter((s) => !s.ok).length,
    minAvailableMb: Math.min(...hostDuring.map((h) => h.availableMb)),
    maxQemuRssMb: Math.max(0, ...hostDuring.map((h) => h.qemuRssMb)),
  };
}

/** The budgets of a level, against the level of one Dot. */
function budgets(result: LevelResult, single: LevelResult | undefined): string[] {
  const broken: string[] = [];
  if (result.apiP95Ms > HEALTH_P95_MS) broken.push(`API p95 ${result.apiP95Ms} ms > ${HEALTH_P95_MS} ms`);
  if (result.apiErrors > 0) broken.push(`${result.apiErrors} API calls failed`);
  if (result.minAvailableMb < MIN_FREE_MB) broken.push(`host memory available fell to ${result.minAvailableMb} MB < ${MIN_FREE_MB} MB`);
  if (single && single !== result) {
    for (const [what, values, base] of [
      ["READY", result.readyMs, single.readyMs],
      ["reply", result.replyMs, single.replyMs],
      ["task", result.taskMs, single.taskMs],
    ] as const) {
      const limit = RATIO * percentile([...base], 50) + SLACK_MS;
      const p95 = percentile([...values], 95);
      if (base.length > 0 && p95 > limit) broken.push(`${what} p95 ${p95} ms > ${RATIO} x ${percentile([...base], 50)} ms + ${SLACK_MS} ms`);
    }
  }
  return broken;
}

// The run

async function main(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  product.logCliTo(join(LOG_DIR, "cli.log"));
  say(`home ${HOME}, logs ${LOG_DIR}, levels ${LEVELS.join(",")}, computer ${COMPUTER.cpu} CPU ${COMPUTER.memory}, model ${MODEL}`);
  assert(process.platform === "linux", "this run is for a Linux host (README)");
  assert(existsSync(CLI), `${CLI} does not exist: build it first (npm run build --workspace @invisible-dots/cli)`);
  assert(KEY_FILE, "set E2E_OPENROUTER_KEY_FILE to a file holding the OpenRouter key");
  const key = keyFromFile(await readFile(KEY_FILE, "utf8"), KEY_FILE, "sk-or-");

  await startServer();
  const leftovers = (await api<{ dots: Dot[] }>("GET", ROUTES.dots)).dots.filter((d) => d.name.startsWith(PREFIX));
  for (const dot of leftovers) await api("DELETE", route(ROUTES.dot, { id: dot.id }));
  for (const dot of leftovers) await waitDeleted(dot.id, `leftover Dot ${dot.name} to be deleted`);
  const stored = await cli(["secret", "openrouter", "--json"], { stdin: `${key}\n` });
  assert(stored.code === 0, `invisible-dots secret openrouter exited with ${stored.code}: ${stored.stderr.trim()}`);

  const samplers = [sampleApi(), sampleHost()];
  const results: LevelResult[] = [];
  try {
    for (const n of LEVELS) {
      const result = await level(n);
      const single = results.find((r) => r.dots === 1);
      result.problems.push(...budgets(result, single ?? (n === 1 ? result : undefined)));
      result.ok = result.problems.length === 0;
      results.push(result);
      const line =
        `${result.ok ? "PASS" : "FAIL"} ${n} Dots: READY p50 ${percentile(result.readyMs, 50)} / p95 ${percentile(result.readyMs, 95)} ms; ` +
        `reply p50 ${percentile(result.replyMs, 50)} / p95 ${percentile(result.replyMs, 95)} ms; task p50 ${percentile(result.taskMs, 50)} / p95 ${percentile(result.taskMs, 95)} ms; ` +
        `delete p95 ${percentile(result.deleteMs, 95)} ms; API p95 ${result.apiP95Ms} ms; min available ${result.minAvailableMb} MB; QEMU RSS max ${result.maxQemuRssMb} MB` +
        (result.ok ? "" : `; ${result.problems.join("; ")}`);
      say(line);
      await appendFile(join(LOG_DIR, "summary.txt"), `${line}\n`);
      await writeFile(join(LOG_DIR, "summary.json"), `${JSON.stringify({ model: MODEL, computer: COMPUTER, budgets: { HEALTH_P95_MS, RATIO, MIN_FREE_MB }, results }, null, 2)}\n`);
    }
  } finally {
    sampling = false;
    await Promise.all(samplers);
    await writeFile(join(LOG_DIR, "samples.json"), `${JSON.stringify({ api: samples, host }, null, 2)}\n`);
  }
  if (results.some((r) => !r.ok)) throw new Failure(`${results.filter((r) => !r.ok).length} of ${results.length} levels failed`);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  say(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await stopServer().catch(() => undefined);
  product.closeCliLog();
}
process.exit(exitCode);
