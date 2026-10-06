/**
 * The message a person has typed and not sent, kept per Dot in this browser so that a reload or a visit to another
 * tab does not lose it. A convenience only: storage can be missing or refuse, and then there is simply no draft.
 */
const PREFIX = "idots.draft.";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDraft(dotId: string, storage: DraftStorage | null = defaultStorage()): string {
  try {
    return storage?.getItem(PREFIX + dotId) ?? "";
  } catch {
    return "";
  }
}

/** An empty text removes the draft. */
export function writeDraft(dotId: string, text: string, storage: DraftStorage | null = defaultStorage()): void {
  try {
    if (text === "") storage?.removeItem(PREFIX + dotId);
    else storage?.setItem(PREFIX + dotId, text);
  } catch {
    // No room, or storage is blocked: the draft is only a convenience.
  }
}
