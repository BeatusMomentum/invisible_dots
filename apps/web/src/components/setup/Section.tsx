import type { ReactNode } from "react";

/** A titled card of the setup pages: a heading, what it is for, an action at the right of the heading, and the body. */
export function Section({
  id,
  title,
  description,
  action,
  busy,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} aria-busy={busy} className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  );
}
