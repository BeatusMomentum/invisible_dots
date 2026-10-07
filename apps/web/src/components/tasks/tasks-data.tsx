"use client";

import { TASK_LIST_LIMIT } from "@invisible-dots/shared/browser";
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

/** The tasks older than the newest page: whether there may be some, reading them, and why that failed. */
export interface OlderTasks {
  available: boolean;
  loading: boolean;
  error: unknown;
  load: () => void;
}

interface TasksData {
  dotId: string;
  /** The newest page of the Dot's tasks, with the older pages the person asked for after it; `reload` reads the newest page again. */
  tasks: Resource<Task[]>;
  older: OlderTasks;
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
  const newest = useResource(() => api.listTasks(dotId), `tasks:${dotId}`);
  useLiveRefresh(newest.reload, TASK_EVENTS);
  const { older, tasks } = useOlderTasks(dotId, newest);
  const runningKey = (tasks.data ?? [])
    .filter((task) => isRunning(task.status))
    .map((task) => task.id)
    .join(",");
  const progress = useTaskProgress(dotId, runningKey);
  const value = useMemo<TasksData>(() => ({ dotId, tasks, older, progress }), [dotId, tasks, older, progress]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The newest first, as the control plane lists them (created, then id). */
function newestFirst(a: Task, b: Task): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * The tasks past the newest page, read a page at a time on request with the id of the last task held as the cursor. The
 * newest page is read again whenever something changes, and a task that a newer one pushed off it is not lost: every task
 * seen is kept (a task is never deleted), the newest page's copy of it being the current one.
 */
function useOlderTasks(dotId: string, newest: Resource<Task[]>): { tasks: Resource<Task[]>; older: OlderTasks } {
  const [seen, setSeen] = useState<ReadonlyMap<string, Task>>(new Map());
  const [ended, setEnded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (newest.data !== undefined) setSeen((current) => withTasks(current, newest.data!));
  }, [newest.data]);

  const joined = useMemo(() => {
    if (newest.data === undefined) return undefined;
    return [...withTasks(seen, newest.data).values()].sort(newestFirst);
  }, [newest.data, seen]);

  const cursor = joined?.at(-1)?.id;
  const full = newest.data !== undefined && newest.data.length >= TASK_LIST_LIMIT;
  const load = useCallback(() => {
    if (cursor === undefined || loading) return;
    setLoading(true);
    setError(null);
    api
      .listTasks(dotId, { before: cursor })
      .then((page) => {
        setSeen((current) => withTasks(current, page));
        setEnded(page.length < TASK_LIST_LIMIT);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [dotId, cursor, loading]);

  const tasks = useMemo<Resource<Task[]>>(() => ({ ...newest, data: joined }), [newest, joined]);
  return { tasks, older: { available: full && !ended, loading, error, load } };
}

/** `known` and `tasks`, a task in both once, as `tasks` has it. */
function withTasks(known: ReadonlyMap<string, Task>, tasks: readonly Task[]): Map<string, Task> {
  const next = new Map(known);
  for (const task of tasks) next.set(task.id, task);
  return next;
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
