"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { isRunning } from "../../lib/task-view";
import type { Task } from "../../lib/types";
import { ErrorAlert } from "../ErrorAlert";
import { useAction } from "../ui";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

/** What cancelling does to a task in this state, said before the person confirms. */
function consequence(task: Pick<Task, "status">): string {
  return isRunning(task.status)
    ? "The Dot stops working on it now. What it already did stays done."
    : "It will not run.";
}

/** Cancel, then an explicit question: a cancelled task cannot be resumed. */
export function CancelTaskButton({ task, onDone, size = "sm" }: { task: Pick<Task, "id" | "description" | "status">; onDone: () => void; size?: "xs" | "sm" }) {
  const [open, setOpen] = useState(false);
  const action = useAction();

  async function confirm() {
    const ok = await action.run(() => api.cancelTask(task.id));
    if (ok) {
      setOpen(false);
      toast.success("The task was cancelled.");
      onDone();
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size={size} onClick={() => setOpen(true)}>
        Cancel<span className="sr-only"> task: {task.description}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) action.setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this task?</DialogTitle>
            <DialogDescription>{consequence(task)}</DialogDescription>
          </DialogHeader>
          <p className="line-clamp-3 rounded-md bg-muted px-3 py-2 text-sm">{task.description}</p>
          <ErrorAlert error={action.error} title="The task was not cancelled" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button type="button" variant="destructive" disabled={action.pending} onClick={() => void confirm()}>
              {action.pending ? "Cancelling..." : "Cancel task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
