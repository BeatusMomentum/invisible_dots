/**
 * vsock CID allocation (architecture section 3.5). CIDs are global to the host
 * kernel, so the control plane's own records are not the whole truth: a CID it
 * believes free can still be held by other software, which is why `virsh
 * start` failing with "Address already in use" moves the Dot to another one.
 */
import { cidBaseFromEnv, DEFAULT_CID_BASE, MAX_GUEST_CID, MIN_GUEST_CID } from "@invisible-dots/shared";

// Re-exported so callers of this package keep one import; the parsing lives in shared.
export { cidBaseFromEnv, MAX_GUEST_CID, MIN_GUEST_CID };

/** The lowest CID at or above `base` that is not in `taken`. */
export function allocateCid(taken: Iterable<number>, base: number = DEFAULT_CID_BASE): number {
  const used = new Set(taken);
  for (let cid = Math.max(base, MIN_GUEST_CID); cid <= MAX_GUEST_CID; cid++) {
    if (!used.has(cid)) return cid;
  }
  throw new Error(`no free vsock CID at or above ${base}`);
}

/** Whether a failed `virsh start` means the CID is held by someone else. */
export function isCidInUseError(stderr: string): boolean {
  return /address already in use/i.test(stderr);
}
