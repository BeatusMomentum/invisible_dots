import type { ChannelRecord } from "@invisible-dots/shared/browser";
import { channelState } from "../../lib/channels";
import { cn } from "../../lib/utils";
import { TONE_CLASS, TONE_DOT } from "../dot/tone";

/** A channel's connection as a pill: a dot in the tone's color and the word. */
export function ChannelStateChip({ record }: { record: Pick<ChannelRecord, "enabled" | "status"> }) {
  const { label, tone } = channelState(record);
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", TONE_CLASS[tone])}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
      <span className="sr-only">Status: </span>
      {label}
    </span>
  );
}
