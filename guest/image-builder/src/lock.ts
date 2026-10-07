/**
 * One build at a time per images directory. Two builds into the same
 * directory would download into the same cache and could both decide that
 * no image exists yet. The lock is the shared pid lock of packages/shared:
 * the golden build also records its builder VM in it, so a later build never
 * takes over while that QEMU still runs (on Linux a QEMU outlives a build
 * that was killed outright).
 */
import { acquirePidLock, type PidLock } from "@invisible-dots/shared";

export type Lock = PidLock;

export function acquireLock(path: string, what: string): Promise<Lock> {
  return acquirePidLock(path, { what, stopHint: "wait for it to finish or stop it", mode: 0o600 });
}
