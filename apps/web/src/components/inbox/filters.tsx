"use client";

import { useRouter } from "next/navigation";
import { PERMISSIONS, PERMISSION_INFO } from "@invisible-dots/shared/browser";
import { inboxHref, type InboxQuery } from "../../lib/inbox";
import type { Dot } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Label } from "../ui/label";

const SELECT_CLASS =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring";

function FilterSelect({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={cn(SELECT_CLASS, "max-w-48")}>
        {children}
      </select>
    </div>
  );
}

/**
 * Filter by Dot and by permission. A choice changes the address (the Inbox's whole state is in it), so it survives a
 * reload and the back button. `dotId` is the Dot the address names, resolved to an id.
 */
export function Filters({ query, dotId, dots }: { query: InboxQuery; dotId: string | null; dots: readonly Dot[] }) {
  const router = useRouter();
  const go = (change: Partial<InboxQuery>) => router.replace(inboxHref({ ...query, ...change }));
  // A Dot the list does not hold (deleted, or still loading) is still a choice: the address asked for it.
  const known = dotId === null || dots.some((dot) => dot.id === dotId);
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <FilterSelect id="inbox-dot" label="Dot" value={dotId ?? ""} onChange={(value) => go({ dot: value === "" ? null : value })}>
        <option value="">All Dots</option>
        {known ? null : <option value={dotId ?? ""}>{dotId}</option>}
        {dots.map((dot) => (
          <option key={dot.id} value={dot.id}>
            {dot.name}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect id="inbox-permission" label="Permission" value={query.permission ?? ""} onChange={(value) => go({ permission: value === "" ? null : value })}>
        <option value="">All permissions</option>
        {query.permission !== null && !(PERMISSIONS as readonly string[]).includes(query.permission) ? <option value={query.permission}>{query.permission}</option> : null}
        {PERMISSIONS.map((permission) => (
          <option key={permission} value={permission}>
            {PERMISSION_INFO[permission].label}
          </option>
        ))}
      </FilterSelect>
    </div>
  );
}
