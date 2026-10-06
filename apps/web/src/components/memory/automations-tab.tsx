"use client";

import type { Automation } from "@invisible-dots/shared/browser";
import { Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { describeSchedule, emptyAutomationsText, lastRunOf, nextRunLabel, sortAutomations } from "../../lib/automations";
import { isComputerStopped } from "../../lib/computer";
import { useNow } from "../../lib/use-now";
import { ComputerOff } from "../computer/computer-off";
import { ConfirmDialog } from "../confirm-dialog";
import { useDot } from "../DotShell";
import { ScheduleCard } from "../elements/schedule-card";
import { ErrorAlert } from "../ErrorAlert";
import { useLiveEvents, useLiveRefresh } from "../events";
import { useAction, useResource } from "../ui";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

/** What changes an automation: a run ends in an answer or a task, a decision lets the Dot make one. The cron tool's own calls are heard below. */
const AUTOMATION_EVENTS = ["message.assistant", "task.completed", "task.failed", "approval.resolved"];

/**
 * The Dot's automations, the jobs its cron tool made: each with its schedule in words, when it runs next, how its
 * last run went, a switch that pauses it and a delete. The person cannot create one here: an automation is the Dot's
 * own act (it asks first by default), and the empty list says how one comes to exist.
 */
export function AutomationsTab({ dotId }: { dotId: string }) {
  const { dot } = useDot();
  const listing = useResource(() => api.listAutomations(dotId), `automations:${dotId}`);
  useLiveRefresh(listing.reload, AUTOMATION_EVENTS);
  useLiveEvents((event) => {
    if (event.data.tool === "cron") listing.reload();
  }, ["tool.called"]);
  // The next and last run read "in 5m" and "2h ago": they are renewed with the clock.
  const now = useNow(30_000);
  const automations = useMemo(() => sortAutomations(listing.data ?? []), [listing.data]);
  const failure = listing.error;

  if (isComputerStopped(failure)) return <ComputerOff dotId={dotId} state="STOPPED" what="Start the computer to see its automations" />;

  return (
    <div className="space-y-4">
      <ErrorAlert error={failure} title="Could not read the automations" />
      {listing.data === undefined && !failure ? (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : null}
      {listing.data !== undefined && automations.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{emptyAutomationsText(dot.data?.config)}</p>
      ) : null}
      {automations.length > 0 ? (
        <ul aria-label="Automations" className="grid gap-4 md:grid-cols-2">
          {automations.map((automation) => (
            <li key={automation.id} className="min-w-0">
              <AutomationItem dotId={dotId} automation={automation} now={now} onChanged={listing.reload} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AutomationItem({ dotId, automation, now, onChanged }: { dotId: string; automation: Automation; now: number; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const toggle = useAction();
  const remove = useAction();

  async function flip() {
    const enabled = !automation.enabled;
    const ok = await toggle.run(() => api.setAutomationEnabled(dotId, automation.id, enabled));
    if (ok) toast.success(enabled ? `Resumed ${automation.name}.` : `Paused ${automation.name}.`);
    // After a refusal too: the automation may be gone or changed, and the list is what is true.
    onChanged();
  }

  async function destroy() {
    const ok = await remove.run(() => api.deleteAutomation(dotId, automation.id));
    if (ok) {
      setAsking(false);
      toast.success(`Deleted ${automation.name}.`);
      onChanged();
    }
  }

  function ask() {
    remove.setError(null);
    setAsking(true);
  }

  return (
    <div className="space-y-2">
      <ScheduleCard
        name={automation.name}
        cadence={describeSchedule(automation.schedule)}
        nextRun={nextRunLabel(automation, now)}
        enabled={automation.enabled}
        lastRun={lastRunOf(automation, now)}
        message={automation.message}
        onToggle={() => void flip()}
        toggleDisabled={toggle.pending}
        actions={
          <Button type="button" variant="outline" size="sm" onClick={ask}>
            <Trash2Icon />
            Delete <span className="sr-only">{automation.name}</span>
          </Button>
        }
      />
      <ErrorAlert error={toggle.error} title={`${automation.name} was not changed`} />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Delete ${automation.name}?`}
        description={
          <>
            The Dot will not run it again. This cannot be undone: the Dot would have to set it up again itself.
          </>
        }
        confirmLabel="Delete automation"
        pendingLabel="Deleting..."
        destructive
        pending={remove.pending}
        error={remove.error}
        errorTitle="The automation was not deleted"
        onConfirm={() => void destroy()}
      />
    </div>
  );
}
