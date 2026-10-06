"use client";

import Link from "next/link";
import { useMemo } from "react";
import { api } from "../../lib/api";
import { askedTitle, askOfRecord, permissionInfo } from "../../lib/approval-view";
import { statusTone, formatDate } from "../../lib/format";
import { matchesFilters } from "../../lib/inbox";
import { relativeTime } from "../../lib/time";
import type { Approval } from "../../lib/types";
import { cn } from "../../lib/utils";
import { TONE_CLASS } from "../dot/tone";
import { ErrorAlert } from "../ErrorAlert";
import { useLiveRefresh } from "../events";
import { useShell } from "../shell/attention";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { useHistory } from "./use-history";

const ANSWER_WORD: Record<string, string> = { approved: "Allowed", rejected: "Denied", expired: "Expired" };

function Answer({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex w-fit items-center rounded-[3px] px-2 py-0.5 text-xs font-medium", TONE_CLASS[statusTone(status)])}>
      <span className="sr-only">Answer: </span>
      {ANSWER_WORD[status] ?? status}
    </span>
  );
}

/**
 * Every approval that is no longer waiting (S6, History): allowed, denied, or expired because the task ended first,
 * the one answered last first. The control plane lists them newest first a page at a time and the older ones are read
 * on request, so the newest answer is always there however many approvals the Dots have asked for.
 */
export function History({ filter }: { filter: { dotId: string | null; permission: string | null } }) {
  const { dots } = useShell();
  const history = useHistory(filter.dotId);
  useLiveRefresh(history.reload, ["approval.requested", "approval.resolved"]);
  const names = useMemo(() => new Map((dots.data ?? []).map((dot) => [dot.id, dot.name])), [dots.data]);

  const rows = useMemo(
    () => (history.rows ?? []).filter((row) => matchesFilters(null, filter.permission, row.dot_id, row.permission)),
    [history.rows, filter.permission],
  );

  return (
    <div className="space-y-4">
      <ErrorAlert error={history.error} title="Could not load the history" />
      {history.rows === undefined && !history.error ? <Skeleton className="h-40 w-full" aria-busy="true" /> : null}

      {history.rows !== undefined && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {history.hasMore
            ? "None of the newest answers are under these filters."
            : `No approval has been answered${filter.dotId !== null || filter.permission !== null ? " under these filters" : " yet"}.`}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">Approvals that were answered, the newest answer first</caption>
            <thead className="bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Answer
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  What the Dot wanted
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Dot
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Permission
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  When
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row: Approval) => {
                const when = row.resolved_at ?? row.created_at;
                return (
                  <tr key={row.id} className="align-top">
                    <td className="px-3 py-2">
                      <Answer status={row.status} />
                    </td>
                    <td className="max-w-96 space-y-0.5 px-3 py-2">
                      <p className="font-medium break-words">{askedTitle(askOfRecord(row))}</p>
                      {row.reason ? <p className="line-clamp-2 text-xs break-words text-muted-foreground">{row.reason}</p> : null}
                      {row.note ? <p className="line-clamp-2 text-xs break-words text-muted-foreground">Note: {row.note}</p> : null}
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/dots/${encodeURIComponent(row.dot_id)}/chat`} className="hover:underline">
                        {names.get(row.dot_id) ?? row.dot_id}
                      </Link>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{permissionInfo(row.permission)?.label ?? row.permission}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <time dateTime={when} title={formatDate(when)}>
                        {relativeTime(when)}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {history.hasMore ? (
        <Button type="button" variant="outline" size="sm" disabled={history.loadingMore} onClick={history.loadMore}>
          {history.loadingMore ? "Loading" : "Show older answers"}
        </Button>
      ) : null}
    </div>
  );
}
