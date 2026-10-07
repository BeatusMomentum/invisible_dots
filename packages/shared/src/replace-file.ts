/**
 * File operations that must wait while another process holds a file for a
 * moment, and the atomic replacement every file in this repository goes
 * through.
 *
 * Windows reports EBUSY, EPERM or EACCES for a file another process holds:
 * an antivirus or an indexer scanning a file that was just written, or a
 * process Windows already reports gone whose handles are not closed yet. A
 * rename over a file fails the same way while either file is held. The
 * operation is right and only has to wait, so it is tried again for a short,
 * bounded time. On Linux nothing holds a file this way, so the first try
 * succeeds and the code path is the same.
 */
import { rename as fsRename } from "node:fs/promises";

/** Error codes Windows gives for a file another process (or a handle not closed yet) holds. */
const IN_USE = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Runs a file operation again while the file is in use, at most `attempts` times. */
export async function retryWhileInUse<T>(operation: () => Promise<T>, attempts = 10, delayMs = 200): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !IN_USE.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export interface ReplaceFileOptions {
  rename?: (from: string, to: string) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}

/** Moves a fully written temporary file over its destination, waiting while either file is held. */
export async function replaceFile(temporary: string, destination: string, options: ReplaceFileOptions = {}): Promise<void> {
  const rename = options.rename ?? fsRename;
  await retryWhileInUse(() => rename(temporary, destination), options.attempts, options.delayMs);
}
