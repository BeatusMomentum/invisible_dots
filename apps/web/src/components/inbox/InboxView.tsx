"use client";

import Link from "next/link";
import { inboxHref, resolveDotFilter, type InboxQuery } from "../../lib/inbox";
import { cn } from "../../lib/utils";
import { useShell } from "../shell/attention";
import { Badge } from "../ui/badge";
import { Filters } from "./filters";
import { History } from "./History";
import { NeedsYou } from "./NeedsYou";

/**
 * The Inbox (S6): everything that needs the person, from every Dot, in one place; and what they already answered.
 * `query` is the address's own state: the tab and the filters by Dot and permission.
 */
export function InboxView({ query }: { query: InboxQuery }) {
  const { dots, needsYou } = useShell();
  const dotId = resolveDotFilter(query.dot, dots.data ?? []);
  const filter = { dotId, permission: query.permission };
  const tab = (id: InboxQuery["tab"]) => ({ href: inboxHref({ ...query, tab: id }), current: query.tab === id });
  const tabs = [
    { id: "needs-you" as const, label: "Needs you", ...tab("needs-you") },
    { id: "history" as const, label: "History", ...tab("history") },
  ];

  return (
    // w-full: the main is a flex column, where auto margins stop the stretch, and without a width a long file in a card
    // would size the page past the screen and push the answers off it on a phone.
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted-foreground">What your Dots are waiting on you for, across all of them.</p>
      </div>

      <nav aria-label="Inbox sections" className="border-b">
        <ul className="flex gap-1">
          {tabs.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                replace
                aria-current={item.current ? "page" : undefined}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  item.current && "border-primary font-medium text-foreground",
                )}
              >
                {item.label}
                {item.id === "needs-you" && needsYou > 0 ? (
                  <Badge role="img" className="bg-warn-soft px-1.5 text-warn" aria-label={`${needsYou} need you`}>
                    {needsYou}
                  </Badge>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Filters query={query} dotId={dotId} dots={dots.data ?? []} />

      {query.tab === "history" ? <History filter={filter} /> : <NeedsYou filter={filter} />}
    </div>
  );
}
