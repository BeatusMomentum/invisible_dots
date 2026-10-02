"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorIssues } from "../lib/api";
import { statusTone } from "../lib/format";

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  const text = status ?? "UNKNOWN";
  return (
    <span className={`badge tone-${statusTone(status)}`}>
      {label ? <span className="visually-hidden">{label}: </span> : null}
      {text}
    </span>
  );
}

export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const issues = errorIssues(error);
  return (
    <div className="error-box" role="alert">
      {title ? <strong>{title}: </strong> : null}
      {message}
      {issues.length > 0 ? (
        <ul>
          {issues.map((issue, i) => (
            <li key={i}>
              {issue.path ? <code>{issue.path}</code> : null}
              {issue.path ? ": " : null}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Load data on mount and whenever `key` changes. Answers that arrive after a
 * newer load started are dropped, so a slow response never overwrites a
 * fresh one.
 */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  const reload = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    loader
      .current()
      .then((value) => {
        if (mine !== generation.current) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (mine !== generation.current) return;
        setError(err);
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    setData(undefined);
    reload();
  }, [key, reload]);

  return { data, error, loading, reload };
}

/** Run an action, tracking its pending state and error. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, setError, run };
}
