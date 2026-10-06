"use client";

import type { ChannelKind, ChannelPeerRecord } from "@invisible-dots/shared/browser";
import { UserMinusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { CHANNEL_LABELS, peersInOrder } from "../../lib/channels";
import { relativeTime } from "../../lib/time";
import { ConfirmDialog } from "../confirm-dialog";
import { useAction } from "../ui";
import { Button } from "../ui/button";

function PeerRow({ dotId, kind, peer, onChanged }: { dotId: string; kind: ChannelKind; peer: ChannelPeerRecord; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const revoke = useAction();

  async function confirm() {
    const ok = await revoke.run(() => api.removeChannelPeer(dotId, kind, peer.peer_id));
    if (ok) {
      setAsking(false);
      toast.success(`${peer.label} is no longer paired.`);
      onChanged();
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium break-words">
          {peer.label}
          {peer.role === "owner" ? <span className="ml-2 rounded-[3px] bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Owner</span> : null}
        </p>
        <p className="text-xs break-all text-muted-foreground">
          {peer.label === peer.peer_id ? null : <>{peer.peer_id} · </>}
          Paired <time dateTime={peer.created_at}>{relativeTime(peer.created_at)}</time>
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          revoke.setError(null);
          setAsking(true);
        }}
      >
        <UserMinusIcon />
        Revoke <span className="sr-only">{peer.label}</span>
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Revoke ${peer.label}?`}
        description={`The Dot stops answering in this chat and sends nothing more to it${peer.role === "owner" ? ", and nobody can answer its approvals there until someone pairs again" : ""}. They can pair again with a new code.`}
        confirmLabel="Revoke"
        pendingLabel="Revoking..."
        keepLabel="Keep"
        destructive
        pending={revoke.pending}
        error={revoke.error}
        errorTitle="The person was not revoked"
        onConfirm={() => void confirm()}
      />
    </li>
  );
}

/** The people paired to a channel: who the Dot answers there, the owner first, each with a Revoke. */
export function PeersList({ dotId, kind, peers, onChanged }: { dotId: string; kind: ChannelKind; peers: readonly ChannelPeerRecord[]; onChanged: () => void }) {
  const name = CHANNEL_LABELS[kind];
  return (
    <section aria-label={`People paired on ${name}`} className="space-y-2">
      <h3 className="text-sm font-medium">People paired</h3>
      {peers.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody yet. The Dot ignores every chat that has not paired, and spends nothing on them.</p>
      ) : (
        <ul className="divide-y rounded-md border px-3">
          {peersInOrder(peers).map((peer) => (
            <PeerRow key={peer.peer_id} dotId={dotId} kind={kind} peer={peer} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}
