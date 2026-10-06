import Link from "next/link";
import { cn } from "../lib/utils";

/**
 * The views of one page of a Dot (Computer: Screen, Browser, Files, Usage) as a segmented row of
 * links. Each view has an address of its own, so it can be linked and the back button walks between them.
 */
export function ViewTabs<View extends string>({
  label,
  views,
  labels,
  current,
  hrefOf,
}: {
  /** The accessible name of the navigation. */
  label: string;
  views: readonly View[];
  labels: Record<View, string>;
  current: View;
  hrefOf: (view: View) => string;
}) {
  return (
    <nav aria-label={label}>
      <ul className="inline-flex gap-1 rounded-lg bg-muted p-1">
        {views.map((view) => (
          <li key={view}>
            <Link
              href={hrefOf(view)}
              aria-current={current === view ? "page" : undefined}
              className={cn(
                "block rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
                current === view && "bg-background font-medium text-foreground shadow-xs",
              )}
            >
              {labels[view]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
