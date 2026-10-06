/** Errors raised by the vm-manager. Each one says which command or VM it is about, and what fixes it when something can. */

/** The commands that prepare a host (architecture section 11); errors and the doctor report about the host name them. */
export const DOCTOR_COMMAND = "invisible-dots doctor";
export const SETUP_COMMAND = "invisible-dots setup";
/** Stores the OpenRouter key: in a terminal it asks for it, one line; piped, it reads standard input. */
export const STORE_OPENROUTER_KEY = "invisible-dots secret openrouter";

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
          ? `command not found (run "${DOCTOR_COMMAND}")`
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
    super(`${feature} is out of scope for this version (architecture section 10)`);
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

/** QEMU (qemu-system-x86_64 or qemu-img) is not installed where the vm-manager looks (section 3.1). */
export class QemuNotFoundError extends Error {
  readonly binary: string;
  readonly searched: readonly string[];
  constructor(binary: string, searched: readonly string[]) {
    super(
      `${binary} was not found (looked in: ${searched.length > 0 ? searched.join(", ") : "nothing"}). ` +
        `Run "${SETUP_COMMAND}" to install QEMU, or set INVISIBLE_DOTS_QEMU_DIR to the directory that holds it; ` +
        `"${DOCTOR_COMMAND}" checks the result.`,
    );
    this.name = "QemuNotFoundError";
    this.binary = binary;
    this.searched = searched;
  }
}

/**
 * QEMU could not use the hardware accelerator. There is no fallback to
 * software emulation (section 1.1): the start fails and says what fixes it.
 */
export class AcceleratorUnavailableError extends Error {
  readonly accelerator: string;
  readonly qemuOutput: string;
  constructor(accelerator: string, qemuOutput: string) {
    super(
      `QEMU could not use the ${accelerator} accelerator, and invisible_dots never falls back to software emulation. ` +
        `Run "${DOCTOR_COMMAND}" to see what is missing and "${SETUP_COMMAND}" to fix it. QEMU said: ${qemuOutput.trim() || "nothing"}`,
    );
    this.name = "AcceleratorUnavailableError";
    this.accelerator = accelerator;
    this.qemuOutput = qemuOutput;
  }
}

/**
 * The accelerator does not run the Dots' CPU model (`CPU_MODEL`, section
 * 3.4). Section 3.4 forbids replacing it with a guessed one, so this is an
 * error to report, not to work around.
 */
export class CpuModelError extends Error {
  readonly accelerator: string;
  readonly qemuOutput: string;
  constructor(accelerator: string, cpuModel: string, qemuOutput: string) {
    super(
      `QEMU rejected "-cpu ${cpuModel}" with the ${accelerator} accelerator. invisible_dots does not substitute another CPU model ` +
        `(architecture section 3.4); run "${DOCTOR_COMMAND}". QEMU said: ${qemuOutput.trim() || "nothing"}`,
    );
    this.name = "CpuModelError";
    this.accelerator = accelerator;
    this.qemuOutput = qemuOutput;
  }
}

/**
 * QEMU exited during start, never set up its port forward, or started but
 * never brought the guest up. `qemuOutput` is what QEMU wrote to its log and
 * `serialOutput` the end of the guest's serial console: together they are
 * what says why, since nothing else watches a VM's insides (section 3.4).
 */
export class VmStartError extends Error {
  readonly dotId: string;
  readonly qemuOutput: string;
  readonly serialOutput: string;
  constructor(dotId: string, message: string, qemuOutput = "", options?: { cause?: unknown; serialOutput?: string }) {
    const output = qemuOutput.trim();
    const serial = (options?.serialOutput ?? "").trim();
    super(
      `dot ${dotId}: ${message}${output ? `. QEMU said: ${output}` : ""}${serial ? `. The serial console ends with: ${serial}` : ""}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "VmStartError";
    this.dotId = dotId;
    this.qemuOutput = qemuOutput;
    this.serialOutput = options?.serialOutput ?? "";
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
