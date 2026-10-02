"use client";

import { useState, type FormEvent } from "react";
import { TERMINAL_TASK_STATES } from "@invisible-dots/shared/browser";
import type { CreateTaskRequest } from "@invisible-dots/sdk";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { useDot } from "./DotShell";
import { useLiveRefresh } from "./events";
import { ErrorBox, StatusBadge, useAction, useResource } from "./ui";

const TASK_EVENTS = ["task.created", "task.started", "task.progress", "task.completed", "task.failed", "task.cancelled"];

/** `<input type="datetime-local">` gives local wall time without a zone; the API wants an instant. */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function TasksTab() {
  const { dotId } = useDot();
  const tasks = useResource(() => api.listTasks(dotId), `tasks:${dotId}`);
  const cancel = useAction();
  useLiveRefresh(tasks.reload, TASK_EVENTS);

  return (
    <>
      <NewTaskForm dotId={dotId} onCreated={tasks.reload} />
      <h2>Tasks</h2>
      <ErrorBox error={tasks.error} title="Could not load tasks" />
      <ErrorBox error={cancel.error} title="The task was not cancelled" />
      {tasks.data && tasks.data.length === 0 ? <p className="muted">No tasks yet.</p> : null}
      {tasks.data && tasks.data.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col">Status</th>
                <th scope="col">Priority</th>
                <th scope="col">Created</th>
                <th scope="col">Finished</th>
                <th scope="col">Result</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.map((task) => (
                <tr key={task.id}>
                  <td>
                    <div>{task.description}</div>
                    <code className="muted small">{task.id}</code>
                    {task.scheduled_at ? <div className="muted small">Scheduled {formatDate(task.scheduled_at)}</div> : null}
                  </td>
                  <td>
                    <StatusBadge status={task.status} />
                  </td>
                  <td>{task.priority}</td>
                  <td>{formatDate(task.created_at)}</td>
                  <td>{formatDate(task.finished_at)}</td>
                  <td className="pre-wrap">{task.error ? <span className="text-error">{task.error}</span> : (task.summary ?? "")}</td>
                  <td>
                    {TERMINAL_TASK_STATES.includes(task.status) ? null : (
                      <button
                        type="button"
                        className="secondary"
                        disabled={cancel.pending}
                        onClick={() => void cancel.run(() => api.cancelTask(task.id)).then((ok) => ok && tasks.reload())}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function NewTaskForm({ dotId, onCreated }: { dotId: string; onCreated: () => void }) {
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("0");
  const [scheduledAt, setScheduledAt] = useState("");
  const action = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const task: CreateTaskRequest = { description: description.trim() };
    const p = Number(priority);
    if (priority.trim() !== "" && Number.isInteger(p)) task.priority = p;
    const when = localInputToIso(scheduledAt);
    if (when) task.scheduled_at = when;
    const ok = await action.run(async () => {
      await api.createTask(dotId, task);
    });
    if (ok) {
      setDescription("");
      setScheduledAt("");
      onCreated();
    }
  }

  return (
    <section className="card" aria-labelledby="new-task">
      <h2 id="new-task">New task</h2>
      <form onSubmit={submit}>
        <label htmlFor="task-description">Description</label>
        <textarea
          id="task-description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        <div className="row">
          <div>
            <label htmlFor="task-priority">Priority</label>
            <input
              id="task-priority"
              type="number"
              step={1}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              aria-describedby="task-priority-hint"
            />
            <p className="hint" id="task-priority-hint">
              Tasks run one at a time, in priority order, then in creation order.
            </p>
          </div>
          <div>
            <label htmlFor="task-scheduled">Not before (optional)</label>
            <input
              id="task-scheduled"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </div>
        </div>
        <ErrorBox error={action.error} title="The task was not created" />
        <div className="actions">
          <button type="submit" disabled={action.pending || !description.trim()}>
            {action.pending ? "Creating..." : "Create task"}
          </button>
        </div>
      </form>
    </section>
  );
}
