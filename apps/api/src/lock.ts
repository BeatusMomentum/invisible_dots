/**
 * One control plane per INVISIBLE_DOTS_HOME. Two servers on the same home
 * would both open the embedded PGlite data directory, which has no locking
 * of its own and is corrupted by a second writer, and both would start and
 * stop the same QEMU processes. A lock file holding the owner's pid stops
 * the second one before it touches anything; the lock itself is the shared
 * pid lock of packages/shared, which also serves the image builds.
 */
import { acquirePidLock, ensurePrivateDir, type HostPaths, type PidLock, type ProcessPresence } from "@invisible-dots/shared";

export type ServerLock = PidLock;

/** Take the server lock of `paths.home`, or fail naming the pid that holds it and the file to remove. */
export async function acquireServerLock(paths: HostPaths, presence?: (pid: number) => ProcessPresence): Promise<ServerLock> {
  // The whole data directory is this user's alone, on Windows too (files.ts).
  await ensurePrivateDir(paths.home);
  return acquirePidLock(paths.serverLockPath, {
    what: "invisible-dots server",
    stopHint: `stop it first (it serves ${paths.home})`,
    ...(presence ? { presence } : {}),
  });
}
