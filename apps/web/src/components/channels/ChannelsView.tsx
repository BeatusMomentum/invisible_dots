"use client";

import { CHANNEL_KINDS, ENV, type ChannelKind, type ChannelRecord } from "@invisible-dots/shared/browser";
import { api } from "../../lib/api";
import { CHANNEL_LABELS } from "../../lib/channels";
import { useDot } from "../DotShell";
import { ErrorAlert } from "../ErrorAlert";
import { useLiveRefresh } from "../events";
import { useResource } from "../ui";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { ChannelCard } from "./channel-card";
import { TelegramCard } from "./telegram-card";
import { WhatsAppCard } from "./whatsapp-card";

/** What changes what the page shows: a connection, a person paired. Their own saves reload it too. */
const CHANNEL_EVENTS = ["channel.status", "channel.peer.paired", "channel.changed"];

/** A channel that is linked but that this server was started without: nothing to do with it from here but know why. */
function Unavailable({ kind, record }: { kind: ChannelKind; record: ChannelRecord }) {
  return (
    <ChannelCard kind={kind} record={record}>
      <p className="text-sm text-muted-foreground">
        {CHANNEL_LABELS[kind]} is linked to this Dot, but this server was started without it, so nothing is sent or read there.
        {kind === "whatsapp" ? ` Start the server with ${ENV.WHATSAPP}=1 again to use it.` : ""}
      </p>
    </ChannelCard>
  );
}

/**
 * The Channels page (S12): where the person talks to the Dot from their phone. One card per channel the server can
 * run, Telegram always and WhatsApp only when the server was started with it; the host owns what is on them and
 * the page follows it live.
 */
export function ChannelsView() {
  const { dotId } = useDot();
  const overview = useResource(() => api.channelsOverview(dotId), `channels:${dotId}`);
  useLiveRefresh(overview.reload, CHANNEL_EVENTS, 150);
  const { data, error, reload } = overview;

  if (data === undefined) {
    return error ? (
      <div className="space-y-3">
        <ErrorAlert error={error} title="Could not read the channels" />
        <Button type="button" variant="outline" size="sm" onClick={reload}>
          Try again
        </Button>
      </div>
    ) : (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  const recordOf = (kind: ChannelKind) => data.channels.find((channel) => channel.kind === kind);
  return (
    <div className="space-y-5">
      <p className="max-w-prose text-sm text-muted-foreground">
        Reach the Dot from a messaging app. A chat has to pair first, with a code you make here; every other chat is ignored. What the Dot says in the web chat stays there: a channel hears only the replies to its own messages, what you ask to be told, and the approvals it is asked for.
      </p>
      <ErrorAlert error={error} title="Could not refresh the channels" />
      {CHANNEL_KINDS.map((kind) => {
        const record = recordOf(kind);
        if (!data.available.includes(kind)) return record ? <Unavailable key={kind} kind={kind} record={record} /> : null;
        return kind === "telegram" ? <TelegramCard key={kind} dotId={dotId} record={record} onChanged={reload} /> : <WhatsAppCard key={kind} dotId={dotId} record={record} onChanged={reload} />;
      })}
    </div>
  );
}
