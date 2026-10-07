"use client";

import type { ChannelKind, ChannelPairingAnswer } from "@invisible-dots/shared/browser";
import { ExternalLinkIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { CHANNEL_LABELS, countdown, pairingHref } from "../../lib/channels";
import { useNow } from "../../lib/use-now";
import { CopyButton } from "../copy-button";
import { ErrorAlert } from "../ErrorAlert";
import { useLiveEvents } from "../events";
import { useAction } from "../ui";
import { Button } from "../ui/button";
import { QrCode } from "./qr-connect";

/**
 * Pairs a person's chat to the Dot: a one-time code, valid for ten minutes, as a link that opens the chat with the
 * code ready to send, as a QR code for a phone, and as the words to type. Whoever sends it first to the channel's
 * account becomes the owner. The panel closes itself when the host says someone paired.
 */
export function PairingPanel({ dotId, kind }: { dotId: string; kind: ChannelKind }) {
  const name = CHANNEL_LABELS[kind];
  const [answer, setAnswer] = useState<ChannelPairingAnswer | null>(null);
  const create = useAction();
  const now = useNow(1000, answer !== null);

  useLiveEvents(
    (event) => {
      if (event.data.kind !== kind) return;
      setAnswer(null);
      toast.success(`${String(event.data.label ?? "Someone")} is paired on ${name}.`);
    },
    ["channel.peer.paired"],
  );

  async function make() {
    const made = await create.run(async () => {
      setAnswer(await api.pairChannel(dotId, kind));
    });
    if (!made) setAnswer(null);
  }

  const left = answer === null ? null : countdown(answer.expires_at, now);
  const href = answer === null ? null : pairingHref(answer.deep_link);

  return (
    <section aria-label={`Link your ${name}`} className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Link your {name}</h3>
        <p className="text-sm text-muted-foreground">Pairing makes a chat the Dot's: it answers there, and only the first person who pairs can answer its approvals. A code works once.</p>
      </div>

      {answer === null || left === null ? (
        <Button type="button" variant="outline" size="sm" disabled={create.pending} onClick={() => void make()}>
          <LinkIcon />
          {create.pending ? "Making a code..." : `Link your ${name}`}
        </Button>
      ) : (
        <div className="grid gap-4 rounded-md border p-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          {href !== null && !left.expired ? <QrCode text={href} label={`QR code that opens ${name} with the pairing code`} className="size-40 rounded-md border" /> : null}
          <div className="min-w-0 space-y-3">
            {href !== null && !left.expired ? (
              <Button asChild size="sm">
                <a href={href} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  Open {name}
                </a>
              </Button>
            ) : null}
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{href !== null ? "Or send this to the account yourself:" : "Send this to the account:"}</p>
              <p className="flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 font-mono text-sm break-all">{answer.message}</code>
                <CopyButton text={answer.message} label="Copy the pairing message" />
              </p>
            </div>
            <p role="timer" aria-label="Time left on the code" className={left.expired ? "text-sm text-danger" : "text-xs text-muted-foreground"}>
              {left.expired ? "This code has expired." : `Expires in ${left.text}.`}
            </p>
            <Button type="button" variant="ghost" size="xs" disabled={create.pending} onClick={() => void make()}>
              New code
            </Button>
          </div>
        </div>
      )}
      <ErrorAlert error={create.error} title="Could not make a pairing code" />
    </section>
  );
}
