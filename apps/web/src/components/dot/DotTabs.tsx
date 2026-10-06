"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../../lib/utils";
import { useDotAttention } from "../shell/attention";

/** The tabs of a Dot's page, each the address of a page that exists, in the order of the design (1.4): what the Dot says and does, then how it is reached, then how it is set up. */
export const DOT_TABS = [
  { slug: "chat", label: "Chat" },
  { slug: "tasks", label: "Tasks" },
  { slug: "computer", label: "Computer" },
  { slug: "memory", label: "Memory" },
  { slug: "activity", label: "Activity" },
  { slug: "channels", label: "Channels" },
  { slug: "settings", label: "Settings" },
] as const;

/** The tab bar: a row of links, scrolling sideways when the screen is too narrow for all of them. */
export function DotTabs({ dotId }: { dotId: string }) {
  const path = usePathname() ?? "";
  const base = `/dots/${encodeURIComponent(dotId)}`;
  const relinks = useDotAttention(dotId).relinks.length;

  return (
    <nav aria-label="Dot sections" className="-mx-4 mt-4 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-1">
        {DOT_TABS.map((tab) => {
          const href = `${base}/${tab.slug}`;
          const current = path === href || path.startsWith(`${href}/`);
          return (
            <li key={tab.slug}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  current && "border-primary font-medium text-foreground",
                )}
              >
                {tab.label}
                {tab.slug === "channels" && relinks > 0 ? <span role="img" aria-label="needs linking again" className="size-2 rounded-[3px] bg-warn" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
