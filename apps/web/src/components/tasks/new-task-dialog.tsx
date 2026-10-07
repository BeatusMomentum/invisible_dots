"use client";

import { PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { EMPTY_TASK_FORM, parsePriority, taskFormProblem, taskRequest, type TaskForm } from "../../lib/task-form";
import { PRIORITIES } from "../../lib/task-view";
import { cn } from "../../lib/utils";
import { ErrorAlert } from "../ErrorAlert";
import { Field } from "../new-dot/Field";
import { useAction } from "../ui";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/** The "New task" button and its dialog: what to do, how urgent, and not before when. */
export function NewTaskDialog({ dotId, onCreated }: { dotId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<TaskForm>(EMPTY_TASK_FORM);
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);
  const action = useAction();
  const problem = taskFormProblem(form);
  const named = PRIORITIES.find((p) => p.value === parsePriority(form.priority))?.id ?? null;

  function change(next: boolean) {
    setOpen(next);
    if (next) return;
    setForm(EMPTY_TASK_FORM);
    setAdvanced(false);
    setTouched(false);
    action.setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (problem !== null) return;
    const ok = await action.run(() => api.createTask(dotId, taskRequest(form)));
    if (ok) {
      change(false);
      toast.success("The task was created.");
      onCreated();
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button type="button">
          <PlusIcon />
          New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>The Dot works on one task at a time, the more urgent first, and tells you what it did.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <Field id="task-description" label="What should it do?" error={touched && form.description.trim() === "" ? "Say what the Dot should do." : null}>
            {(control) => <Textarea {...control} rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} autoFocus />}
          </Field>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Priority</legend>
            <div className="flex flex-wrap gap-2">
              {PRIORITIES.map((priority) => (
                <label
                  key={priority.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring has-[:focus-visible]:outline-hidden",
                    named === priority.id && "border-primary bg-accent",
                  )}
                >
                  <input type="radio" name="task-priority" className="accent-primary" checked={named === priority.id} onChange={() => setForm({ ...form, priority: String(priority.value) })} />
                  {priority.label}
                </label>
              ))}
            </div>
          </fieldset>

          <Field id="task-not-before" label="Not before" optional hint="Leave empty to run it as soon as the Dot is free.">
            {(control) => <Input {...control} type="datetime-local" value={form.notBefore} onChange={(e) => setForm({ ...form, notBefore: e.target.value })} />}
          </Field>

          <div className="space-y-2">
            <Button type="button" variant="ghost" size="xs" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
              Advanced
            </Button>
            {advanced ? (
              <Field
                id="task-priority-raw"
                label="Priority as a number"
                hint="Higher runs first. Low, Normal, High and Urgent are -10, 0, 10 and 100."
                error={parsePriority(form.priority) === null ? "The priority is a whole number." : null}
              >
                {(control) => <Input {...control} inputMode="numeric" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />}
              </Field>
            ) : null}
          </div>

          <ErrorAlert error={action.error} title="The task was not created" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => change(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={action.pending}>
              {action.pending ? "Creating..." : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
