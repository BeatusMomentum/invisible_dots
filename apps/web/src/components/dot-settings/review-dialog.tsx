"use client";

import type { ConfigChange } from "../../lib/config-fields";
import { ConfirmDialog } from "../confirm-dialog";

/**
 * What a save would write, before it is written: each field that changed, from what it is to what it will be. Nothing is
 * sent until the person confirms, and a refusal stays in the dialog with its reason so they can fix it or give up.
 */
export function ReviewDialog({
  open,
  onOpenChange,
  dotName,
  changes,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dotName: string;
  changes: readonly ConfigChange[];
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save these changes?"
      description={`${changes.length === 1 ? "This change is" : `These ${changes.length} changes are`} written to ${dotName}'s configuration, and pushed to it if its computer is running.`}
      confirmLabel="Save changes"
      pendingLabel="Saving..."
      keepLabel="Keep editing"
      pending={pending}
      error={error}
      errorTitle="The configuration was not saved"
      onConfirm={onConfirm}
    >
      <ul aria-label="Changes" className="max-h-72 space-y-2 overflow-y-auto text-sm">
        {changes.map((change) => (
          <li key={change.key} className="rounded-md border p-2.5">
            <p className="font-medium">{change.label}</p>
            <p className="break-words whitespace-pre-wrap">
              <span className="text-muted-foreground">from</span> <del className="text-muted-foreground">{change.before}</del> <span className="text-muted-foreground">to</span> <ins className="font-medium no-underline">{change.after}</ins>
            </p>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
