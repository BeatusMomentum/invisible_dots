import { computerStateLabel } from "../../lib/computer";
import { statusTone } from "../../lib/format";
import { cn } from "../../lib/utils";
import { TONE_DOT } from "../dot/tone";

/** The computer's state: a dot in the tone's color and the state's word. */
export function ComputerStatus({ state }: { state: string }) {
  const tone = statusTone(state);
  return (
    <span className="inline-flex w-fit items-center gap-1.5 text-xs font-medium">
      <span aria-hidden="true" className={cn("size-2 rounded-full", TONE_DOT[tone])} />
      <span className="sr-only">Computer state: </span>
      {computerStateLabel(state)}
    </span>
  );
}
