"use client";

import { toast } from "sonner";
import { api } from "../../lib/api";
import { useDot } from "../DotShell";
import { ErrorAlert } from "../ErrorAlert";
import { useAction } from "../ui";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/** What memory being on or off means for the Dot: the engine offers its memory tools only while it is on (`memory.enabled`). */
const WHAT_IT_DOES = {
  on: "The Dot is offered the tools that search and read its notes, and its prompt names the notes it changed most recently.",
  off: "The Dot is not offered the tools that search and read its notes, and its prompt no longer names them. The notes on its disk stay, and you can still read them here.",
} as const;

/**
 * The switch of `memory.enabled`. The whole config is saved with the one field changed, conditional on the version
 * of the config this page read (`expected_config_version`): if the config changed meanwhile, in another tab or by an
 * "Always allow", nothing is saved and the page says so, rather than undoing what the other change did.
 */
export function MemorySwitch() {
  const { dotId, dot } = useDot();
  const config = dot.data?.config;
  const version = dot.data?.config_version;
  const save = useAction();
  const enabled = config?.memory.enabled;

  async function change(next: boolean) {
    if (config === undefined || version === undefined) return;
    const ok = await save.run(() => api.updateDot(dotId, { ...config, memory: { ...config.memory, enabled: next } }, version));
    if (ok) toast.success(next ? "Memory is on. The change applies from the Dot's next turn." : "Memory is off. The change applies from the Dot's next turn.");
    // A refused save means the config is not what this page read: read it again.
    dot.reload();
  }

  return (
    <section aria-labelledby="memory-switch-label" className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <Label id="memory-switch-label" htmlFor="memory-switch" className="text-sm font-medium">
            {enabled === undefined ? "Memory" : enabled ? "Memory is on" : "Memory is off"}
          </Label>
          {enabled === undefined ? null : <p className="text-sm text-muted-foreground">{enabled ? WHAT_IT_DOES.on : WHAT_IT_DOES.off}</p>}
        </div>
        <Switch id="memory-switch" checked={enabled ?? false} disabled={enabled === undefined || save.pending} onCheckedChange={(next) => void change(next)} />
      </div>
      <ErrorAlert error={save.error} title="Memory was not changed" />
    </section>
  );
}
