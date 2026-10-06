"use client";

import type { ChannelRecord } from "@invisible-dots/shared/browser";
import { PauseIcon, PlayIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { CHANNEL_LABELS, CHANNEL_NOTES } from "../../lib/channels";
import { ConfirmDialog } from "../confirm-dialog";
import { ErrorAlert } from "../ErrorAlert";
import { useAction } from "../ui";
import { Button } from "../ui/button";
import { PairingPanel } from "./pairing-panel";
import { PeersList } from "./peers-list";
import { SettingsSwitches } from "./settings-switches";

/** What removing each channel is called and does, said before it is done. */
const REMOVAL: Record<ChannelRecord["kind"], { verb: string; done: string; effect: string }> = {
  telegram: { verb: "Disconnect", done: "disconnected", effect: "The bot's token is deleted from this machine and every paired person is removed. The bot itself stays yours at @BotFather." },
  whatsapp: {
    verb: "Unlink",
    done: "unlinked",
    effect: "The link to the number is deleted from this machine and every paired person is removed. WhatsApp's Linked devices list on the phone may still show this device until you remove it there.",
  },
};

/** Pause or resume the channel, and remove it with everything it holds. */
function Footer({ dotId, record, onChanged }: { dotId: string; record: ChannelRecord; onChanged: () => void }) {
  const name = CHANNEL_LABELS[record.kind];
  const [asking, setAsking] = useState(false);
  const pause = useAction();
  const remove = useAction();
  const { verb, done, effect } = REMOVAL[record.kind];

  async function flip() {
    const enabled = !record.enabled;
    const ok = await pause.run(() => api.patchChannel(dotId, record.kind, { enabled }));
    if (ok) toast.success(enabled ? `${name} is resumed.` : `${name} is paused. Nothing is sent or read there until you resume it.`);
    onChanged();
  }

  async function destroy() {
    const ok = await remove.run(() => api.removeChannel(dotId, record.kind));
    if (ok) {
      setAsking(false);
      toast.success(`${name} is ${done}.`);
      onChanged();
    }
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <ErrorAlert error={pause.error} title={`${name} was not changed`} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={pause.pending} onClick={() => void flip()}>
          {record.enabled ? <PauseIcon /> : <PlayIcon />}
          {record.enabled ? "Pause" : "Resume"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            remove.setError(null);
            setAsking(true);
          }}
        >
          <UnplugIcon />
          {verb}
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`${verb} ${name}?`}
        description={effect}
        confirmLabel={verb}
        pendingLabel={`${verb === "Unlink" ? "Unlinking" : "Disconnecting"}...`}
        destructive
        pending={remove.pending}
        error={remove.error}
        errorTitle={`${name} was not ${done}`}
        onConfirm={() => void destroy()}
      />
    </div>
  );
}

/** What a channel that exists has in common, whatever its kind: pairing, the people paired, what it does, and pause and removal. */
export function LinkedChannel({ dotId, record, onChanged }: { dotId: string; record: ChannelRecord; onChanged: () => void }) {
  return (
    <div className="space-y-6">
      <PairingPanel dotId={dotId} kind={record.kind} />
      <PeersList dotId={dotId} kind={record.kind} peers={record.peers} onChanged={onChanged} />
      <SettingsSwitches dotId={dotId} record={record} onChanged={onChanged} />
      <p className="text-xs text-muted-foreground">{CHANNEL_NOTES[record.kind]}</p>
      <Footer dotId={dotId} record={record} onChanged={onChanged} />
    </div>
  );
}
