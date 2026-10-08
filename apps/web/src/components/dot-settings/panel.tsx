import type { ReactNode } from "react";
import type { DotConfig } from "@invisible-dots/shared/browser";

/** What a panel of the settings needs: the config being edited, how to change it, and the problem of a path of it, if it has one. */
export interface PanelProps {
  draft: DotConfig;
  /** The config as the host has it: what the person is editing from. */
  saved: DotConfig;
  change: (next: DotConfig) => void;
  /** The schema's complaint about a config path (`limits.max_steps_per_task`), or null. */
  errorOf: (path: string) => string | null;
}

/** One section of the settings: a card with a title the page can be navigated by, and a line on what it holds. */
export function Panel({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  const headingId = `settings-${id}`;
  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-lg border bg-card p-5">
      <div>
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
