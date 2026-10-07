/**
 * Reads the builder VM's serial console while it runs. QEMU appends to a
 * plain file on every host, so following it is polling the file for new
 * bytes: no pty, no named pipe, nothing that differs between Linux and
 * Windows.
 */
import { open, type FileHandle } from "node:fs/promises";

export const PROGRESS_PREFIX = "idots-build: ";
export const COMPONENT_PREFIX = "IDOTS-BUILD-COMPONENT: ";
export const RESULT_PREFIX = "IDOTS-BUILD-RESULT: ";

export type BuildVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The provisioner's verdict from the whole console text. The last result
 * line wins; no result line at all means the guest powered off (or was
 * stopped) before the provisioner finished, which is a failure too.
 */
export function buildVerdict(consoleText: string): BuildVerdict {
  let last: string | undefined;
  for (const line of consoleLines(consoleText)) {
    const at = line.indexOf(RESULT_PREFIX);
    if (at >= 0) last = line.slice(at + RESULT_PREFIX.length).trim();
  }
  if (last === undefined) return { ok: false, reason: "the provisioner reported no result before the VM stopped" };
  return last === "ok" ? { ok: true } : { ok: false, reason: last };
}

/**
 * name=value pairs the provisioner printed about what it installed. Values
 * are kept to printable ASCII and 200 characters: they come from inside a VM
 * and go into a JSON manifest and a terminal.
 */
export function installedComponents(consoleText: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of consoleLines(consoleText)) {
    const at = line.indexOf(COMPONENT_PREFIX);
    if (at < 0) continue;
    const match = /^([a-z0-9][a-z0-9-]*)=(.*)$/.exec(line.slice(at + COMPONENT_PREFIX.length).trim());
    if (match) found[match[1]!] = match[2]!.replace(/[^\x20-\x7e]/g, "?").slice(0, 200).trim();
  }
  return found;
}

function consoleLines(text: string): string[] {
  // The kernel and getty write "\r\n"; a stray "\r" mid-line is a cursor return.
  return text.split(/\r?\n/).map((line) => line.slice(line.lastIndexOf("\r") + 1));
}

export interface SerialFollower {
  /** Reads what is left and stops polling. Safe to call twice. */
  stop(): Promise<void>;
  /** The last lines seen, for error messages. */
  tail(count: number): string[];
}

/**
 * Calls `onProgress` with every progress line the provisioner prints, as it
 * prints it. The file may not exist yet when this starts (QEMU creates it).
 */
export function followSerialLog(path: string, onProgress: (step: string) => void, pollMs = 1000): SerialFollower {
  let handle: FileHandle | undefined;
  let offset = 0;
  let partial = "";
  const recent: string[] = [];
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const buffer = Buffer.alloc(64 * 1024);

  const take = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const clean = line.slice(line.lastIndexOf("\r") + 1);
    recent.push(clean);
    if (recent.length > 200) recent.shift();
    const at = clean.indexOf(PROGRESS_PREFIX);
    if (at >= 0) onProgress(clean.slice(at + PROGRESS_PREFIX.length).trim());
  };

  const readNew = async () => {
    if (!handle) {
      try {
        handle = await open(path, "r");
      } catch {
        return;
      }
    }
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      // latin1 never fails on bytes; the lines that matter are ASCII.
      const lines = (partial + buffer.toString("latin1", 0, bytesRead)).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
  };

  const tick = () => {
    running = running.then(readNew).catch(() => undefined);
  };
  const timer = setInterval(tick, pollMs);
  tick();

  return {
    async stop() {
      if (stopped) return running;
      stopped = true;
      clearInterval(timer);
      tick();
      await running;
      if (partial !== "") take(partial);
      partial = "";
      await handle?.close().catch(() => undefined);
    },
    tail(count) {
      return recent.slice(-count);
    },
  };
}
