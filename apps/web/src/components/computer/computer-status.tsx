import { statusTone } from "../../lib/format";
import { cn } from "../../lib/utils";
import { TONE_CLASS, TONE_DOT } from "../dot/tone";

/** The computer's state as a pill: a dot in the tone's color and the state's word. */
export function ComputerStatus({ state }: { state: string }) {
  const tone = statusTone(state);
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", TONE_CLASS[tone])}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
      <span className="sr-only">Computer state: </span>
      {state}
    </span>
  );
}
