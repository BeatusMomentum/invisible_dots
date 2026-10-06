"use client";

import { EyeIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type { IdentityActivity } from "../../lib/browser-activity";
import { formatDate } from "../../lib/format";
import { identityStatus } from "../../lib/identity";
import { relativeTime } from "../../lib/time";
import type { BrowserIdentity } from "../../lib/types";
import { cn } from "../../lib/utils";
import { ConfirmDialog } from "../confirm-dialog";
import { TONE_CLASS, TONE_DOT } from "../dot/tone";
import { useAction } from "../ui";
import { Button } from "../ui/button";

/** The marker of a browser the Dot is working in at this moment. */
export function UsingNow() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-info-soft px-2 py-0.5 text-xs font-medium text-info">
      <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-info motion-reduce:animate-none" />
      The Dot is using this now
    </span>
  );
}

function StatusChip({ identity }: { identity: BrowserIdentity }) {
  const { label, tone } = identityStatus(identity.status);
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", TONE_CLASS[tone])}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
      <span className="sr-only">Status: </span>
      {label}
    </span>
  );
}

/**
 * One browser identity: a profile with its cookies and logins, open or not. The person can watch an open one, close
 * it (the profile stays) or delete it with its profile; closing a browser the Dot is working in, and deleting any,
 * ask first.
 */
export function IdentityCard({
  dotId,
  identity,
  activity,
  watching,
  now,
  onWatch,
  onChanged,
}: {
  dotId: string;
  identity: BrowserIdentity;
  activity: IdentityActivity;
  watching: boolean;
  now: number;
  onWatch: () => void;
  onChanged: () => void;
}) {
  const open = identity.status === "open";
  const [asking, setAsking] = useState<"close" | "delete" | null>(null);
  const close = useAction();
  const remove = useAction();

  async function closeBrowser() {
    const ok = await close.run(() => api.closeIdentity(dotId, identity.id));
    if (ok) {
      setAsking(null);
      toast.success(`Closed ${identity.name}.`);
      onChanged();
    }
  }

  async function deleteIdentity() {
    const ok = await remove.run(() => api.deleteIdentity(dotId, identity.id));
    if (ok) {
      setAsking(null);
      toast.success(`Deleted ${identity.name}.`);
      onChanged();
    }
  }

  function ask(what: "close" | "delete") {
    close.setError(null);
    remove.setError(null);
    setAsking(what);
  }

  return (
    <article aria-label={identity.name} className={cn("space-y-3 rounded-lg border bg-card p-4 text-card-foreground", watching && "border-primary")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={identity.name}>
          {identity.name}
        </h3>
        <StatusChip identity={identity} />
        {activity.usingNow ? <UsingNow /> : null}
      </div>

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted-foreground">
        <dt>Last used</dt>
        <dd>
          {identity.lastUsedAt ? (
            <time dateTime={identity.lastUsedAt} title={formatDate(identity.lastUsedAt)}>
              {relativeTime(identity.lastUsedAt, now)}
            </time>
          ) : (
            "never"
          )}
        </dd>
        <dt>Proxy</dt>
        <dd>{identity.hasProxy ? "yes" : "none"}</dd>
        <dt>Id</dt>
        <dd>
          <code>{identity.id}</code>
        </dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        {open && !watching ? (
          <Button type="button" variant="outline" size="xs" onClick={onWatch}>
            <EyeIcon />
            Watch<span className="sr-only"> {identity.name}</span>
          </Button>
        ) : null}
        {open ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => (activity.usingNow ? ask("close") : void closeBrowser())}
            disabled={close.pending}
          >
            <XIcon />
            Close<span className="sr-only"> {identity.name}</span>
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="xs" onClick={() => ask("delete")}>
          <Trash2Icon />
          Delete<span className="sr-only"> {identity.name}</span>
        </Button>
      </div>
      {open && asking === null ? <ErrorOfClose error={close.error} /> : null}

      <ConfirmDialog
        open={asking === "close"}
        onOpenChange={(next) => !next && setAsking(null)}
        title={`Close ${identity.name}?`}
        description="The Dot is working in this browser. Closing it ends what the Dot is doing there; the profile, with its cookies and logins, stays."
        confirmLabel="Close browser"
        pendingLabel="Closing..."
        pending={close.pending}
        error={close.error}
        errorTitle="The browser was not closed"
        onConfirm={() => void closeBrowser()}
      />
      <ConfirmDialog
        open={asking === "delete"}
        onOpenChange={(next) => !next && setAsking(null)}
        title={`Delete ${identity.name}?`}
        description={
          <>
            Its profile is deleted with it: the cookies, the logins and the history the Dot built up in it.
            {open ? " The browser is closed first." : ""} This cannot be undone.
          </>
        }
        confirmLabel="Delete identity"
        pendingLabel="Deleting..."
        destructive
        pending={remove.pending}
        error={remove.error}
        errorTitle="The identity was not deleted"
        onConfirm={() => void deleteIdentity()}
      />
    </article>
  );
}

/** A close that failed without a question open: said under the buttons that were pressed. */
function ErrorOfClose({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      The browser was not closed: {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
