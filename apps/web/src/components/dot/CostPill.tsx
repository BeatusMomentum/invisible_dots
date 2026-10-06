"use client";

import { api } from "../../lib/api";
import { formatUsd, startOfToday } from "../../lib/format";
import { DotEventScope, useLiveRefresh } from "../events";
import { Badge } from "../ui/badge";
import { useResource } from "../ui";

const SPEND_EVENTS = ["message.assistant", "task.completed", "task.failed"];

/**
 * What the Dot's model calls cost since midnight, as its guest reported them. The pill is scoped to its own Dot, so
 * wherever it is shown (the Dot's header, every card of Home) it re-reads only when that Dot spends.
 */
export function CostPill({ dotId }: { dotId: string }) {
  return (
    <DotEventScope dotId={dotId}>
      <Spend dotId={dotId} />
    </DotEventScope>
  );
}

function Spend({ dotId }: { dotId: string }) {
  const since = startOfToday();
  const usage = useResource(() => api.usage(dotId, { since }), `usage:${dotId}:${since}`);
  useLiveRefresh(usage.reload, SPEND_EVENTS);
  if (usage.data === undefined) return null;
  return (
    <Badge variant="outline" title="Model spend today, as the Dot's computer reported it">
      <span className="sr-only">Spent today: </span>
      {formatUsd(usage.data.spent_usd)}
    </Badge>
  );
}
