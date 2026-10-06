"use client";

import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../lib/api";
import { ConfirmDialog } from "../confirm-dialog";
import { useAction } from "../ui";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * The one thing in the settings that cannot be undone: the Dot, its computer, its disk and everything on it. The
 * person types the Dot's name before the button works, and a refusal stays in the dialog.
 */
export function DeleteDot({ dotId, name }: { dotId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const remove = useAction();

  function change(next: boolean) {
    setOpen(next);
    if (!next) {
      setTyped("");
      remove.setError(null);
    }
  }

  async function destroy() {
    const ok = await remove.run(() => api.deleteDot(dotId));
    if (ok) router.push("/");
  }

  return (
    <section aria-labelledby="settings-danger" className="space-y-3 rounded-lg border border-danger/50 bg-card p-5">
      <div>
        <h2 id="settings-danger" className="text-base font-semibold">
          Danger zone
        </h2>
        <p className="text-sm text-muted-foreground">Delete this Dot: its computer, its disk and everything stored on it (files, memory, browser identities) are destroyed. This cannot be undone.</p>
      </div>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        <Trash2Icon />
        Delete Dot
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={change}
        title={`Delete ${name}?`}
        description="Its computer and its disk are destroyed, with every file, memory note and browser identity on them. The history of what it did is kept in the log."
        confirmLabel="Delete Dot"
        pendingLabel="Deleting..."
        keepLabel="Keep it"
        destructive
        confirmDisabled={typed !== name}
        pending={remove.pending}
        error={remove.error}
        errorTitle="The Dot was not deleted"
        onConfirm={() => void destroy()}
      >
        <div className="space-y-1.5">
          <Label htmlFor="confirm-delete-name">
            Type <code className="font-mono">{name}</code> to confirm
          </Label>
          <Input id="confirm-delete-name" value={typed} autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.target.value)} />
        </div>
      </ConfirmDialog>
    </section>
  );
}
