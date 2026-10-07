"use client";

import type { ChannelKind, ChannelRecord } from "@invisible-dots/shared/browser";
import { api } from "../../lib/api";
import { SETTING_ORDER, settingTexts, type SettingName } from "../../lib/channels";
import { ErrorAlert } from "../ErrorAlert";
import { useAction } from "../ui";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

function SettingRow({ dotId, kind, name, value, onChanged }: { dotId: string; kind: ChannelKind; name: SettingName; value: boolean; onChanged: () => void }) {
  const save = useAction();
  const text = settingTexts(kind)[name];
  const id = `${kind}-${name}`;

  async function change(next: boolean) {
    await save.run(() => api.patchChannel(dotId, kind, { settings: { [name]: next } }));
    // After a refusal too: the channel may be gone or changed, and the host's record is what is true.
    onChanged();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor={id} className="text-sm font-medium">
            {text.label}
          </Label>
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            {text.description}
          </p>
        </div>
        <Switch id={id} aria-describedby={`${id}-description`} checked={value} disabled={save.pending} onCheckedChange={(next) => void change(next)} />
      </div>
      <ErrorAlert error={save.error} title={`"${text.label}" was not changed`} />
    </div>
  );
}

/** What the channel sends the person without being asked, as three switches that save as they are flipped. */
export function SettingsSwitches({ dotId, record, onChanged }: { dotId: string; record: ChannelRecord; onChanged: () => void }) {
  return (
    <section aria-label="What the channel does" className="space-y-4">
      <h3 className="text-sm font-medium">What it does here</h3>
      {SETTING_ORDER.map((name) => (
        <SettingRow key={name} dotId={dotId} kind={record.kind} name={name} value={record.settings[name]} onChanged={onChanged} />
      ))}
    </section>
  );
}
