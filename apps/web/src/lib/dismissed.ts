/**
 * The ids of the failed tasks this person has dismissed from the Inbox, kept in this browser so that a reload does not
 * bring them back. A convenience only: storage can be missing or refuse, and then they simply show again.
 */
const KEY = "idots.dismissed-tasks";
/** The newest this many are kept: a task leaves the Inbox after a day anyway. */
const KEEP = 200;

type DismissedStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): DismissedStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDismissed(storage: DismissedStorage | null = defaultStorage()): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remember `ids` (oldest first); only the newest KEEP are stored. */
export function writeDismissed(ids: Iterable<string>, storage: DismissedStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify([...ids].slice(-KEEP)));
  } catch {
    // No room, or storage is blocked: the dismissal lasts until the page is closed.
  }
}
