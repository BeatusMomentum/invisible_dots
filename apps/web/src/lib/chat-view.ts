/** What the chat says around the conversation: whether the person can write, what to tell them about the computer, and what to offer as a first message. */
import type { Dot } from "./types";

export interface ComposerState {
  /** Why the person cannot send; null when they can. */
  blocked: string | null;
  /** What is good to know before sending; null when nothing. */
  hint: string | null;
}

/**
 * A message is accepted whenever the Dot exists: the control plane stores it and delivers it once the computer is
 * up (`delivery: "queued"`), waking it if it sleeps. So the person is stopped only for a Dot that will not answer
 * (disabled) or no longer exists (being deleted), and told in a sentence when the answer will take a while.
 */
export function composerState(dot: Pick<Dot, "status" | "computer_state"> | undefined): ComposerState {
  if (dot === undefined) return { blocked: null, hint: null };
  if (dot.computer_state === "DELETING") return { blocked: "This Dot is being deleted.", hint: null };
  if (dot.status === "DISABLED") return { blocked: "This Dot is disabled, so it does not answer.", hint: null };
  switch (dot.computer_state) {
    case "PROVISIONING":
    case "STARTING":
      return { blocked: null, hint: "The computer is getting ready. Your message is delivered as soon as it is." };
    case "STOPPED":
      return { blocked: null, hint: "The computer is stopped. Sending a message wakes it, and the Dot answers once it is up." };
    case "STOPPING":
      return { blocked: null, hint: "The computer is shutting down. Your message is delivered when it is up again." };
    default:
      return { blocked: null, hint: null };
  }
}

const GOAL_EXCERPT = 90;

/** Three first messages to offer in an empty chat, the last taken from the Dot's goal. */
export function suggestions(goal: string | undefined): string[] {
  const text = (goal ?? "").trim().replace(/\s+/g, " ");
  const excerpt = text.length > GOAL_EXCERPT ? `${text.slice(0, GOAL_EXCERPT - 3).trimEnd()}...` : text;
  return ["Tell me what you will do first.", "What can you do on your computer?", excerpt ? `Start on your goal: ${excerpt}` : "What do you need from me to get started?"];
}
