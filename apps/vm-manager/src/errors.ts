/** Errors raised by the vm-manager. Each one says which command or VM it is about. */

/** A host command exited non-zero, timed out or could not be started. */
export class CommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** The errno code when the command could not be started at all (ENOENT when it is not installed). */
  readonly code: string | undefined;

  constructor(init: {
    command: string;
    args: readonly string[];
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
    code?: string;
    message?: string;
    cause?: unknown;
  }) {
    const line = [init.command, ...init.args].join(" ");
    const stderr = (init.stderr ?? "").trim();
    const reason =
      init.message ??
      (init.timedOut
        ? "timed out"
        : init.code === "ENOENT"
          ? "command not found (is it installed and on PATH?)"
          : `exited with code ${init.exitCode}`);
    super(`${line}: ${reason}${stderr ? `: ${stderr}` : ""}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "CommandError";
    this.command = init.command;
    this.args = init.args;
    this.exitCode = init.exitCode;
    this.stdout = init.stdout ?? "";
    this.stderr = init.stderr ?? "";
    this.timedOut = init.timedOut ?? false;
    this.code = init.code;
  }

  /** Whether the command itself is missing from the host. */
  get notFound(): boolean {
    return this.code === "ENOENT";
  }
}

/** A feature the contract places out of scope for this version (architecture section 10). */
export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is out of scope for this version`);
    this.name = "NotImplementedError";
  }
}

/** The operation needs the VM in another state, e.g. a disk resize on a running VM. */
export class VmStateError extends Error {
  readonly dotId: string;
  constructor(dotId: string, message: string) {
    super(`dot ${dotId}: ${message}`);
    this.name = "VmStateError";
    this.dotId = dotId;
  }
}

/** Invalid input to the vm-manager (a bad dot id, a shrinking disk, a missing image). */
export class VmManagerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VmManagerError";
  }
}

/** A guest route answered with an error status, or with something that is not the expected shape. */
export class GuestRequestError extends Error {
  readonly status: number;
  /** The `error` code of an `{ error, message }` body, when the guest sent one. */
  readonly code: string | undefined;
  readonly route: string;

  constructor(route: string, status: number, message: string, code?: string) {
    super(`${route}: ${status === 0 ? "" : `HTTP ${status}: `}${message}`);
    this.name = "GuestRequestError";
    this.route = route;
    this.status = status;
    this.code = code;
  }
}
