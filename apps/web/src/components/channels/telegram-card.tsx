"use client";

import type { ChannelRecord } from "@invisible-dots/shared/browser";
import { AlertTriangleIcon } from "lucide-react";
import { CHANNEL_NOTES } from "../../lib/channels";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ChannelCard } from "./channel-card";
import { LinkedChannel } from "./linked-channel";
import { TokenForm } from "./token-form";

/**
 * Telegram (S12): a bot per Dot. Not connected, the person makes a bot with @BotFather and pastes its token; connected,
 * the card pairs people, lists them and says what the bot does. A token Telegram refused (revoked, or the bot deleted)
 * is a login only the person can redo: the channel says so and takes a new token, keeping the people paired.
 */
export function TelegramCard({ dotId, record, onChanged }: { dotId: string; record: ChannelRecord | undefined; onChanged: () => void }) {
  if (record === undefined) {
    return (
      <ChannelCard kind="telegram" record={undefined}>
        <p className="text-sm text-muted-foreground">
          Talk to the Dot from Telegram. It gets a bot of its own: make one with @BotFather, paste its token here, then pair your chat with a code.
        </p>
        <TokenForm dotId={dotId} relink={false} onSaved={onChanged} />
        <p className="text-xs text-muted-foreground">{CHANNEL_NOTES.telegram}</p>
      </ChannelCard>
    );
  }

  const needsToken = record.status === "needs_relink";
  return (
    <ChannelCard kind="telegram" record={record}>
      {needsToken || (record.status === "error" && record.status_detail) ? (
        <Alert variant={needsToken ? "default" : "destructive"}>
          <AlertTriangleIcon />
          <AlertTitle>{needsToken ? "Telegram needs a new token" : "Telegram has a problem"}</AlertTitle>
          <AlertDescription>
            <p>{record.status_detail ?? "Telegram refused the token: it was revoked, or the bot was deleted."}</p>
            {needsToken ? <p>Paste a new token below. The people already paired stay paired.</p> : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {needsToken ? <TokenForm dotId={dotId} relink onSaved={onChanged} /> : null}
      <LinkedChannel dotId={dotId} record={record} onChanged={onChanged} />
    </ChannelCard>
  );
}
