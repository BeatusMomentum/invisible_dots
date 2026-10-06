import type { Tone } from "../../lib/tone";

/** The classes of a state chip, by tone: a soft surface with the tone's own text color. */
export const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  error: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-muted text-muted-foreground",
};

/** The fill of the small dot in front of a state chip's word, by tone. */
export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  error: "bg-danger",
  info: "bg-info",
  neutral: "bg-muted-foreground",
};

/** The edge of a row of a log, by tone: a colored line down its left side, the only place the tone shows. */
export const TONE_EDGE: Record<Tone, string> = {
  ok: "border-l-ok",
  warn: "border-l-warn",
  error: "border-l-danger",
  info: "border-l-info",
  neutral: "border-l-border",
};
