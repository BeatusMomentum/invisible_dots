/**
 * The two builds the quick start used to ask for by hand, as steps of `invisible-dots setup --all`: the guest
 * daemon dot-agentd (Go) and the web client (Next). What each one runs is owned elsewhere (the image builder names the
 * Go command, apps/web/scripts/build.mjs is the web build); this file runs it and says what happened. Both go
 * through the host's one process runner, with an argument array and never a shell.
 */
import { agentdBuildCommand, defaultRuntimeInputs } from "@invisible-dots/image-builder";
import { WEB_BUILD_COMMAND, type Runner, type RunResult } from "@invisible-dots/vm-manager";
import { webBuildScript } from "../web.js";

/** A step either went through (and says what it did) or stopped the run (and says what to do). */
export interface StepResult {
  ok: boolean;
  lines: string[];
}

export interface BuildDeps {
  run: Runner;
  /** The environment the builds start from; the Go build adds its own variables. */
  env: Record<string, string | undefined>;
  repoRoot: string;
  /** The program that runs the web build script: the node running this command. */
  node: string;
  /** Whether the web client is built completely (`locateWebBuild`). */
  webBuilt(): Promise<boolean>;
}

/**
 * How to get Go: both hosts' commands in one line, so that no platform check is needed to choose one. setup never
 * runs it (the Windows installer and snap each ask for administrator rights of their own, and setup asks once).
 */
export const GO_INSTALL_HINT = "install it: on Windows `winget install -e --id GoLang.Go`, on Linux `sudo snap install go --classic`, or see https://go.dev/dl";

/** Go downloads its toolchain when go.mod asks for a newer one, and compiles the daemon from a cold cache. */
const AGENT_TIMEOUT_MS = 15 * 60_000;
const WEB_TIMEOUT_MS = 30 * 60_000;
const STDERR_LINES = 10;

function why(answer: RunResult, limit: number): string {
  if (answer.timedOut) return `it did not finish within ${limit / 60_000} minutes`;
  return answer.startError?.message ?? `exit code ${answer.code ?? answer.signal}`;
}

/**
 * Builds dot-agentd. Always run, never skipped: Go keeps its own build cache, so an unchanged daemon takes seconds,
 * and the image builder turns the same bytes into "already built".
 */
export async function buildAgent(deps: BuildDeps): Promise<StepResult> {
  const build = agentdBuildCommand(deps.repoRoot);
  const answer = await deps.run(build.command, build.args, { env: { ...deps.env, ...build.env }, timeoutMs: AGENT_TIMEOUT_MS });
  if (answer.startError?.code === "ENOENT") {
    return {
      ok: false,
      lines: [
        "Go is not installed, or is not on PATH: the guest daemon dot-agentd is written in Go",
        GO_INSTALL_HINT,
        "then open a new terminal (the installer changes PATH) and run: invisible-dots setup --all",
      ],
    };
  }
  if (answer.code !== 0 || answer.timedOut) {
    const tail = answer.stderr.trim().split(/\r?\n/).slice(-STDERR_LINES);
    return { ok: false, lines: [`building dot-agentd failed (${why(answer, AGENT_TIMEOUT_MS)}):`, ...tail.filter((line) => line.trim() !== "").map((line) => `  ${line}`)] };
  }
  return { ok: true, lines: [`built ${defaultRuntimeInputs(deps.repoRoot).agentdBinary}`] };
}

/** Builds the web client unless it is complete already (a rebuild after an update is the command this prints). */
export async function buildWeb(deps: BuildDeps): Promise<StepResult> {
  if (await deps.webBuilt()) return { ok: true, lines: [`already built; after an update, build it again with: ${WEB_BUILD_COMMAND}`] };
  // The output is the person's to see: a Next build takes minutes and prints its progress.
  const answer = await deps.run(deps.node, [webBuildScript(deps.repoRoot)], {
    env: deps.env,
    inheritStdio: true,
    timeoutMs: WEB_TIMEOUT_MS,
  });
  if (answer.code !== 0 || answer.timedOut) {
    return { ok: false, lines: [`building the web client failed (${why(answer, WEB_TIMEOUT_MS)}; its output is above)`, `after fixing it, run: invisible-dots setup --all`] };
  }
  if (!(await deps.webBuilt())) {
    return { ok: false, lines: [`the web client build finished but its server files are not where invisible-dots looks (apps/web/.next/standalone); build it with: ${WEB_BUILD_COMMAND}`] };
  }
  return { ok: true, lines: ["built the web client"] };
}
