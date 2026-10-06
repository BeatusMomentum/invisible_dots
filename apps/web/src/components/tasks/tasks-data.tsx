"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { loadTaskEvents, mergeTaskEvents } from "../../lib/task-events";
import { isRunning } from "../../lib/task-view";
import type { StoredEvent, Task } from "../../lib/types";
import { useLiveEvents, useLiveRefresh } from "../events";
import { useResource, type Resource } from "../ui";

const TASK_EVENTS = ["task.created", "task.started", "task.progress", "task.completed", "task.failed", "task.cancelled", "approval.requested", "approval.resolved"];

export type TaskEventsStatus = "idle" | "loading" | "loaded" | "failed";

export interface TaskEvents {
  /** The events of this Dot's tasks, oldest first: what was read from the log, and what arrived live since. */
  events: readonly StoredEvent[];
  status: TaskEventsStatus;
  error: unknown;
  /** Read the log again after a failure. */
  retry: () => void;
}

interface TasksData {
  dotId: string;
  tasks: Resource<Task[]>;
  history: TaskEvents;
}

const Context = createContext<TasksData | null>(null);

export function useTasks(): TasksData {
  const value = useContext(Context);
  if (!value) throw new Error("useTasks must be used inside TasksProvider");
  return value;
}

/**
 * The tasks of one Dot, kept current by the live stream, and the events that tell what they did. The log is read
 * only once something needs it (a task is running, or one is open): a Dot with no work in sight costs
 * nothing, and once read, live events keep it current.
 */
export function TasksProvider({ dotId, taskOpen, children }: { dotId: string; taskOpen: boolean; children: ReactNode }) {
  const tasks = useResource(() => api.listTasks(dotId), `tasks:${dotId}`);
  useLiveRefresh(tasks.reload, TASK_EVENTS);
  const history = useTaskEvents(dotId, taskOpen || (tasks.data ?? []).some((task) => isRunning(task.status)));
  const value = useMemo<TasksData>(() => ({ dotId, tasks, history }), [dotId, tasks, history]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function useTaskEvents(dotId: string, wanted: boolean): TaskEvents {
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [status, setStatus] = useState<TaskEventsStatus>("idle");
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);

  useLiveEvents((event) => setEvents((current) => mergeTaskEvents(current, [event])));

  const load = useCallback(() => {
    const mine = ++generation.current;
    setStatus("loading");
    loadTaskEvents(api, dotId)
      .then((read) => {
        if (mine !== generation.current) return;
        setEvents((current) => mergeTaskEvents(current, read));
        setError(null);
        setStatus("loaded");
      })
      .catch((failure: unknown) => {
        if (mine !== generation.current) return;
        setError(failure);
        setStatus("failed");
      });
  }, [dotId]);

  useEffect(() => {
    if (wanted && status === "idle") load();
  }, [wanted, status, load]);

  // A failed read is not retried by itself: the page says so and offers it.
  return useMemo(() => ({ events, status, error, retry: load }), [events, status, error, load]);
}
