import type { Tone } from "../../lib/timeline";

/** The classes of a state chip, by tone: a soft surface with the tone's own text color. */
export const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  error: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-muted text-muted-foreground",
};
