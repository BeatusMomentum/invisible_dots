/**
 * `invisible-dots setup` (architecture section 11.2): run doctor, install
 * only what is missing for QEMU and its accelerator, then check again. The
 * rest of doctor's list (images, the web client, the OpenRouter key) has its own commands,
 * which setup names at the end instead of running.
 */
import type { DoctorCheck, DoctorCheckId } from "@invisible-dots/shared";
import { allOk, runDoctor, STORE_OPENROUTER_KEY, WEB_BUILD_COMMAND, type DoctorDeps } from "@invisible-dots/vm-manager";
import { renderReport } from "../doctor/render.js";
import { EXIT } from "../exit.js";
import { installHostPrerequisites, setupRefusal, type InstallDeps, type InstallOutcome, type InstallRequest } from "./install.js";

/** The checks setup is responsible for; it succeeds when these are ok. */
export const SETUP_CHECKS: readonly DoctorCheckId[] = ["qemu", "qemu-img", "accelerator", "accelerator-probe"];

export interface SetupDeps {
  doctor: DoctorDeps;
  install: InstallDeps;
  out(text: string): void;
  /** Default: the platform module's installHostPrerequisites; tests pass a fake. */
  installPrerequisites?: (request: InstallRequest, deps: InstallDeps) => Promise<InstallOutcome>;
}

function byId(results: readonly DoctorCheck[]): Map<DoctorCheckId, DoctorCheck> {
  return new Map(results.map((r) => [r.id, r]));
}

function setupReady(results: readonly DoctorCheck[]): boolean {
  const checks = byId(results);
  return SETUP_CHECKS.every((id) => checks.get(id)?.status === "ok");
}

/** What is left after QEMU and the accelerator, as the commands that do it. */
export function nextSteps(results: readonly DoctorCheck[]): string[] {
  const checks = byId(results);
  const steps: string[] = [];
  if (checks.get("golden-image")?.status !== "ok" || checks.get("runtime-image")?.status !== "ok") steps.push("invisible-dots image build");
  // The row is optional (`DoctorDeps.webBuild`): a report without it has no client to build.
  const web = checks.get("web");
  if (web && web.status !== "ok") steps.push(WEB_BUILD_COMMAND);
  if (checks.get("openrouter")?.status !== "ok") {
    steps.push("invisible-dots server   (keep it running, then in another terminal:)");
    steps.push(STORE_OPENROUTER_KEY);
  } else {
    steps.push("invisible-dots server");
  }
  return steps;
}

function printOutcome(outcome: InstallOutcome, out: (text: string) => void): void {
  for (const line of outcome.lines) out(`${line}\n`);
}

/** What `prepareHost` ends with: the doctor report once QEMU and the accelerator are ready, or the exit code of the run that could not get them ready. */
export type HostOutcome = { ready: true; results: readonly DoctorCheck[] } | { ready: false; code: number };

/**
 * The work of `setup`, up to QEMU and its accelerator being ready: the one place that does it, run by `setup` itself
 * and as a step of `setup --all`. It prints what it does; what to do next is the caller's to say.
 */
export async function prepareHost(deps: SetupDeps): Promise<HostOutcome> {
  const { out } = deps;
  const refusal = setupRefusal(deps.install);
  if (refusal) {
    out(`${refusal}\n`);
    return { ready: false, code: EXIT.usage };
  }
  out("checking this host first (invisible-dots doctor):\n\n");
  const before = await runDoctor(deps.doctor);
  out(`${renderReport(before)}\n`);

  const checks = byId(before);
  const status = (id: DoctorCheckId) => checks.get(id)?.status;
  const request = {
    installQemu: status("qemu") !== "ok" || status("qemu-img") !== "ok",
    enableAccelerator: status("accelerator") === "missing",
  };

  if (setupReady(before)) {
    out("QEMU and its accelerator are ready; nothing to install.\n");
    return { ready: true, results: before };
  }
  if (!request.installQemu && !request.enableAccelerator) {
    out("setup cannot fix this by installing something:\n");
    for (const id of SETUP_CHECKS) {
      const check = checks.get(id);
      if (check && check.status !== "ok") out(`  ${check.label}: ${check.detail}${check.fix ? `\n  fix: ${check.fix}` : ""}\n`);
    }
    return { ready: false, code: EXIT.failed };
  }
  let outcome: InstallOutcome;
  try {
    outcome = await (deps.installPrerequisites ?? installHostPrerequisites)(request, deps.install);
  } catch (error) {
    outcome = { kind: "failed", lines: [(error as Error).message] };
  }
  printOutcome(outcome, out);
  if (outcome.kind === "restart") return { ready: false, code: EXIT.restart };
  if (outcome.kind === "failed") {
    out("setup stopped; nothing after the failed step was run.\n");
    return { ready: false, code: EXIT.failed };
  }
  if (outcome.kind === "manual") {
    out("then run: invisible-dots doctor\n");
    return { ready: false, code: EXIT.failed };
  }
  out("\nchecking again:\n\n");
  const after = await runDoctor(deps.doctor);
  out(`${renderReport(after)}\n`);
  if (!setupReady(after)) {
    out("QEMU or its accelerator is still not usable; see the fix lines above.\n");
    return { ready: false, code: EXIT.failed };
  }
  return { ready: true, results: after };
}

export async function runSetup(deps: SetupDeps): Promise<number> {
  const outcome = await prepareHost(deps);
  return outcome.ready ? finish(outcome.results, deps.out) : outcome.code;
}

function finish(results: readonly DoctorCheck[], out: (text: string) => void): number {
  if (allOk(results)) {
    out("this host is ready: invisible-dots server\n");
  } else {
    out("QEMU is ready. Next:\n");
    for (const step of nextSteps(results)) out(`  ${step}\n`);
  }
  return EXIT.ok;
}
