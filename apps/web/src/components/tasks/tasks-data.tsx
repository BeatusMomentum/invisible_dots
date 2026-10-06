"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { mergeTaskEvents, progressOfEvent, readTaskProgress, readTaskStory, taskIdOf, type TaskProgress } from "../../lib/task-events";
import { isRunning } from "../../lib/task-view";
import type { StoredEvent, Task } from "../../lib/types";
import { useLiveEvents, useLiveRefresh } from "../events";
import { useResource, type Resource } from "../ui";

const TASK_EVENTS = ["task.created", "task.started", "task.progress", "task.completed", "task.failed", "task.cancelled", "approval.requested", "approval.resolved"];

export type ReadStatus = "loading" | "loaded" | "failed";

export interface TaskProgressRead {
  status: ReadStatus;
  /** The newest line the task reported, from what was read and what arrived live; null when it has reported nothing. */
  progress: TaskProgress | null;
}

/** What each running task last reported. */
export interface TaskProgressReads {
  of: (taskId: string) => TaskProgressRead;
  /** Read it again after a failure. */
  retry: (taskId: string) => void;
}

interface TasksData {
  dotId: string;
  tasks: Resource<Task[]>;
  progress: TaskProgressReads;
}

const Context = createContext<TasksData | null>(null);

export function useTasks(): TasksData {
  const value = useContext(Context);
  if (!value) throw new Error("useTasks must be used inside TasksProvider");
  return value;
}

/**
 * The tasks of one Dot, kept current by the live stream, and the line each running task last reported. That line is
 * one request per running task (the newest report of that task); a Dot with no work in sight reads nothing, and a
 * task's whole story is read only when its drawer opens (`useTaskStory`).
 */
export function TasksProvider({ dotId, children }: { dotId: string; children: ReactNode }) {
  const tasks = useResource(() => api.listTasks(dotId), `tasks:${dotId}`);
  useLiveRefresh(tasks.reload, TASK_EVENTS);
  const runningKey = (tasks.data ?? [])
    .filter((task) => isRunning(task.status))
    .map((task) => task.id)
    .join(",");
  const progress = useTaskProgress(dotId, runningKey);
  const value = useMemo<TasksData>(() => ({ dotId, tasks, progress }), [dotId, tasks, progress]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The newer of two reports: the id of the event says which, whether it was read or came live. */
function newer(a: TaskProgress | null, b: TaskProgress | null): TaskProgress | null {
  return a === null || (b !== null && b.id > a.id) ? b : a;
}

function useTaskProgress(dotId: string, runningKey: string): TaskProgressReads {
  const [reads, setReads] = useState<Record<string, TaskProgressRead>>({});
  const asked = useRef(new Set<string>());

  useLiveEvents((event) => {
    const taskId = taskIdOf(event);
    if (taskId === "") return;
    setReads((current) => {
      const before = current[taskId];
      return { ...current, [taskId]: { status: before?.status ?? "loading", progress: newer(before?.progress ?? null, progressOfEvent(event)) } };
    });
  }, ["task.progress"]);

  const read = useCallback(
    (taskId: string) => {
      asked.current.add(taskId);
      const settle = (status: ReadStatus, found: TaskProgress | null) =>
        setReads((current) => ({ ...current, [taskId]: { status, progress: newer(current[taskId]?.progress ?? null, found) } }));
      settle("loading", null);
      readTaskProgress(api, dotId, taskId).then(
        (found) => settle("loaded", found),
        () => settle("failed", null),
      );
    },
    [dotId],
  );

  useEffect(() => {
    for (const taskId of runningKey === "" ? [] : runningKey.split(",")) if (!asked.current.has(taskId)) read(taskId);
  }, [runningKey, read]);

  return useMemo(() => ({ of: (taskId) => reads[taskId] ?? { status: "loading", progress: null }, retry: read }), [reads, read]);
}

export interface TaskStory {
  /** The events of the task, oldest first: what was read from the log, and what arrived live since. */
  events: readonly StoredEvent[];
  status: ReadStatus;
  error: unknown;
  /** Read the log again after a failure. */
  retry: () => void;
}

/** One task's events, read when `wanted` (its drawer is open and the task is this Dot's) and followed live. */
export function useTaskStory(dotId: string, taskId: string, wanted: boolean): TaskStory {
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [status, setStatus] = useState<ReadStatus>("loading");
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useLiveEvents((event) => {
    if (taskIdOf(event) === taskId) setEvents((current) => mergeTaskEvents(current, [event]));
  });

  useEffect(() => {
    if (!wanted) return;
    let current = true;
    setStatus("loading");
    readTaskStory(api, dotId, taskId).then(
      (read) => {
        if (!current) return;
        setEvents((held) => mergeTaskEvents(held, read));
        setError(null);
        setStatus("loaded");
      },
      (failure: unknown) => {
        if (!current) return;
        setError(failure);
        setStatus("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [dotId, taskId, wanted, attempt]);

  return useMemo(() => ({ events, status, error, retry: () => setAttempt((n) => n + 1) }), [events, status, error]);
}
