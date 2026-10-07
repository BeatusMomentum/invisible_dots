"use client";

import { PlusIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { filterDots, showSearch } from "../../lib/dot-card";
import { ErrorAlert } from "../ErrorAlert";
import { SetupChecklist } from "../setup/SetupChecklist";
import { useShell } from "../shell/attention";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { DotCard } from "./DotCard";

/**
 * Home (S2): a card per Dot, searchable once there are more than six, and for a person with none an invitation to
 * create the first. It reads the Dots from the shell, which keeps them live, so a Dot made, changed or deleted
 * anywhere shows here without a refresh.
 */
export function HomePage() {
  const { dots } = useShell();
  const [query, setQuery] = useState("");
  const list = dots.data;
  const shown = useMemo(() => (list ? filterDots(list, query) : []), [list, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight">
          Dots{list && list.length > 0 ? <span className="font-mono text-sm font-normal text-muted-foreground">{list.length}</span> : null}
        </h1>
        {list && list.length > 0 ? (
          <Button asChild size="sm">
            <Link href="/new">
              <PlusIcon />
              New Dot
            </Link>
          </Button>
        ) : null}
      </div>

      {dots.error !== null && list === undefined ? <ErrorAlert error={dots.error} title="Could not load the Dots" /> : null}

      {list === undefined && dots.error === null ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading the Dots">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : null}

      {list?.length === 0 ? <EmptyHome /> : null}

      {list && list.length > 0 ? (
        <>
          {showSearch(list.length) ? (
            <div className="relative max-w-sm">
              <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" aria-label="Search Dots" placeholder="Search by name or model" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" />
            </div>
          ) : null}
          {shown.length > 0 ? (
            <div className="divide-y rounded-lg border bg-card">
              {shown.map((dot) => (
                <DotCard key={dot.id} dot={dot} />
              ))}
            </div>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              No Dot matches &ldquo;{query.trim()}&rdquo;.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Nothing here yet: three dots that become one, and the way to make it. */
function EmptyHome() {
  return (
    <section aria-labelledby="empty-title" className="flex flex-col items-center gap-4 rounded-lg border bg-card px-6 py-14 text-center">
      <span aria-hidden="true" className="flex gap-1.5">
        <span className="size-3 rounded-full bg-foreground" />
        <span className="size-3 rounded-full bg-foreground/50" />
        <span className="size-3 rounded-full bg-foreground/20" />
      </span>
      <div className="space-y-1">
        <h2 id="empty-title" className="text-lg font-semibold">
          No Dots yet
        </h2>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          A Dot is an agent that lives on a computer of its own, keeps working while you are away, and asks you before it does anything you have not allowed.
        </p>
      </div>
      <SetupChecklist />
      <Button asChild>
        <Link href="/new">Create your first Dot</Link>
      </Button>
    </section>
  );
}
