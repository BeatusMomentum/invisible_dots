/** What a Dot's card on the Home page says, and how the page narrows the cards down. */
import type { AgentState } from "@invisible-dots/shared/browser";
import { statePill, type StatePill } from "./agent";
import type { Dot } from "./types";

/** The search box appears when there are more Dots than this. */
export const SEARCH_THRESHOLD = 6;

export function showSearch(dotCount: number): boolean {
  return dotCount > SEARCH_THRESHOLD;
}

/** The Dots whose name, goal or model contains every word of `query`, in the order given. */
export function filterDots(dots: readonly Dot[], query: string): Dot[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...dots];
  return dots.filter((dot) => {
    const text = `${dot.name}\n${dot.config?.goal ?? ""}\n${dot.config?.model?.id ?? ""}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export interface CardStatus extends StatePill {
  /** Why the Dot is in ERROR, as the control plane recorded it; null when it is not. */
  reason: string | null;
}

/** The status chip of a card: the same pill the Dot's header shows, and the reason beside an error. */
export function cardStatus(dot: Pick<Dot, "status" | "error">, agent: AgentState | null): CardStatus {
  const pill = statePill(dot.status, agent);
  return { ...pill, reason: dot.status === "ERROR" ? (dot.error ?? "No reason was recorded.") : null };
}
