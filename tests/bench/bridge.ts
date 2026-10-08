/**
 * What the benchmark's Harbor environment and agent (dots_harbor/) ask of the product, one command per call,
 * through the same outside driver as the end-to-end run (tests/e2e/driver.ts): the HTTP API and dot-agentd
 * on a running computer. The input comes on stdin, the answer is JSON on stdout (`get` writes the file's
 * bytes instead).
 *
 *   node tests/bench/bridge.ts ready <key file>          waits for the server, stores the key, deletes the bench-
 *                                                        Dots a stopped run left
 *   node tests/bench/bridge.ts create <name>             stdin: the Dot's YAML; waits for READY; {"id"}
 *   node tests/bench/bridge.ts delete <dot id>           waits until it is gone
 *   node tests/bench/bridge.ts task <dot id> <ms>        stdin: the description; waits for the end; the task
 *   node tests/bench/bridge.ts exec <dot id> <ms>        stdin: a bash command, run as dot; its exit and output
 *   node tests/bench/bridge.ts put <dot id> <path>       stdin: the bytes of a file under /home/dot
 *   node tests/bench/bridge.ts get <dot id> <path>       stdout: the bytes of a file under /home/dot
 *
 * INVISIBLE_DOTS_HOME and INVISIBLE_DOTS_URL name the server, as for the runs of tests/e2e.
 */

import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MINUTE, Product, waitFor } from "../e2e/driver.ts";
import { assert, keyFromFile, ROUTES, route, type Dot, type Task } from "../e2e/lib.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const product = new Product({
  repo: REPO,
  home: resolve(process.env.INVISIBLE_DOTS_HOME?.trim() || join(homedir(), ".invisible-dots")),
  logDir: tmpdir(),
  cli: resolve(process.env.E2E_CLI?.trim() || join(REPO, "apps", "cli", "dist", "invisible-dots.mjs")),
  apiUrl: (process.env.INVISIBLE_DOTS_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, ""),
  webUrl: "",
  web: false,
  timeouts: { cli: 2 * MINUTE, server: 2 * MINUTE, ready: 20 * MINUTE, task: 4 * 60 * MINUTE, delete: 5 * MINUTE },
});

async function stdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const [command, target, extra] = process.argv.slice(2);
assert(command && target, "usage: bridge.ts create|delete|task|exec|put|get <name or dot id> [ms or path]");

switch (command) {
  case "ready": {
    await waitFor("the server to answer /api/health", 2 * MINUTE, async () => {
      const health = await product.api<{ status: string }>("GET", ROUTES.health).catch(() => undefined);
      return health?.status === "ok" ? true : undefined;
    }, 500);
    const key = keyFromFile(await readFile(target, "utf8"), target, "sk-or-");
    const stored = await product.cli(["secret", "openrouter", "--json"], { stdin: `${key}\n` });
    assert(stored.code === 0, `invisible-dots secret openrouter exited with ${stored.code}: ${stored.stderr.trim()}`);
    const leftovers = (await product.api<{ dots: Dot[] }>("GET", ROUTES.dots)).dots.filter((d) => d.name.startsWith("bench-"));
    for (const dot of leftovers) await product.api("DELETE", route(ROUTES.dot, { id: dot.id }));
    for (const dot of leftovers) await product.waitDeleted(dot.id, `leftover Dot ${dot.name} to be deleted`);
    print({ ready: true, removed: leftovers.length });
    break;
  }
  case "create": {
    const dot = await product.api<Dot>("POST", ROUTES.dots, { config: (await stdin()).toString("utf8") });
    await product.waitReady(dot.id);
    print({ id: dot.id });
    break;
  }
  case "delete":
    await product.api("DELETE", route(ROUTES.dot, { id: target }));
    await product.waitDeleted(target, `Dot ${target} to be deleted`);
    print({ deleted: target });
    break;
  case "task": {
    const timeoutMs = Number(extra);
    const description = (await stdin()).toString("utf8");
    const task = await product.api<Task>("POST", route(ROUTES.tasks, { id: target }), { description });
    const ended = await waitFor(`task ${task.id} to end`, timeoutMs, async () => {
      const now = await product.api<Task>("GET", route(ROUTES.task, { id: task.id }));
      return ["COMPLETED", "FAILED", "CANCELLED"].includes(now.status) ? now : undefined;
    }, 5000).catch(async (error: unknown) => {
      // Out of time: the task is cancelled, so the Dot stops working on it before it is graded.
      await product.api("POST", `${route(ROUTES.task, { id: task.id })}/cancel`).catch(() => undefined);
      throw error;
    });
    print(ended);
    break;
  }
  case "exec": {
    const result = await product.guestExec(target, (await stdin()).toString("utf8"), Number(extra));
    print(result);
    break;
  }
  case "put":
    await product.guestPut(target, extra!, new Uint8Array(await stdin()));
    print({ written: extra });
    break;
  case "get":
    process.stdout.write(await product.guestGet(target, extra!));
    break;
  default:
    throw new Error(`unknown command ${command}`);
}
