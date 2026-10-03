// Derived from Open Multi-Agent (MIT), Copyright (c) Shenzhen YuanASI Technology
// Co., Ltd. and open-multi-agent contributors. Modified for invisible_dots.
// See guest-runtime/engine/LICENSE and UPSTREAM.md.
/**
 * Errors the engine raises on purpose. Anything else that escapes a unit of
 * work is a failure of that unit, reported to the owner with its message.
 */

/**
 * Thrown into a running unit to stop it. The reason says what happens to its
 * state: a suspension (a prepare-sleep or a shutdown) leaves everything in
 * place for the next start; a cancel ends the task.
 */
export class UnitAbort extends Error {
  readonly code = "UNIT_ABORT";

  constructor(readonly reason: "suspend" | "cancel") {
    super(reason === "suspend" ? "the agent is preparing to sleep" : "the task was cancelled");
    this.name = "UnitAbort";
  }
}

/** Throw the abort reason when the signal is aborted; a signal aborted without a UnitAbort counts as a suspension. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof UnitAbort ? signal.reason : new UnitAbort("suspend");
}

/** The reason of an aborted signal, as a UnitAbort reason. */
export function abortReason(signal: AbortSignal): UnitAbort["reason"] {
  return signal.reason instanceof UnitAbort ? signal.reason.reason : "suspend";
}
