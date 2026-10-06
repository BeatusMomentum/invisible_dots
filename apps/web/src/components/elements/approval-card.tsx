// Derived from assistant-ui packages/ui/src/components/react/assistant-ui/elements/approval-card.tsx at 0bdf050, MIT; changed: the four states are this app's approval receipts (allowed, denied, expired, answered somewhere else) and the card is wide enough for a diff; the three answers are shadcn buttons of this app's tokens and keep the order deny, always allow, allow once; the body, a form slot (a note, an error) and a disabled state while an answer is on its way are new; the details list and the destructive variant are kept; no surfaces.tsx classes.
"use client";

import { CheckIcon, ClockIcon, InfoIcon, TerminalIcon, XIcon } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";
import type { Receipt } from "../../lib/approval-view";
import { RECEIPT_WORD } from "../../lib/approval-view";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type ApprovalState = "request" | Receipt;

const RECEIPT_ICON: Record<Receipt, ReactNode> = {
  approved: <CheckIcon aria-hidden="true" className="size-3.5 text-ok" />,
  rejected: <XIcon aria-hidden="true" className="size-3.5 text-danger" />,
  expired: <ClockIcon aria-hidden="true" className="size-3.5" />,
  elsewhere: <InfoIcon aria-hidden="true" className="size-3.5" />,
};

export interface ApprovalCardProps extends Omit<ComponentProps<"div">, "title" | "children"> {
  state: ApprovalState;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Why the Dot asked, in its own words. */
  description?: string | undefined;
  /** What would be allowed: a command, a diff, a list of facts. */
  children?: ReactNode;
  details?: readonly { label: string; value: string }[] | undefined;
  /** Between the body and the answers: a note field, an error. */
  form?: ReactNode;
  variant?: "default" | "destructive";
  icon?: ReactNode;
  /** An answer is on its way: the three buttons wait. */
  pending?: boolean;
  onAllowOnce?: (() => void) | undefined;
  onAlwaysAllow?: (() => void) | undefined;
  onDeny?: (() => void) | undefined;
  /** Replaces the receipt's words (for instance to say the answer was an "always"). */
  statusLabel?: ReactNode;
  /** Said under the answers while the card waits. */
  footnote?: ReactNode;
}

/**
 * A request for permission: what the Dot wants to do, what that would involve, and the answers (allow once, always
 * allow, deny). Once answered it is a receipt, and the receipt is all that is left of the buttons.
 */
export function ApprovalCard({
  state,
  title,
  subtitle,
  description,
  children,
  details,
  form,
  variant = "default",
  icon,
  pending = false,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  statusLabel,
  footnote,
  className,
  ...props
}: ApprovalCardProps) {
  const titleId = useId();
  const descriptionId = useId();
  const destructive = variant === "destructive";

  return (
    <div
      {...props}
      role="group"
      data-variant={variant}
      data-state={state}
      data-slot="approval-card"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn("flex w-full flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground", destructive && state === "request" && "border-danger/40", className)}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", destructive ? "bg-danger-soft text-danger" : "bg-muted text-muted-foreground")}>
          {icon ?? <TerminalIcon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-sm font-medium break-words">
            {title}
          </p>
          {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>

      {description ? (
        <p id={descriptionId} className="text-sm break-words text-muted-foreground">
          {description}
        </p>
      ) : null}

      {state === "request" ? children : null}

      {state === "request" && details?.length ? (
        <dl className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2">
          {details.map((detail, index) => (
            <div key={`${detail.label}-${index}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 text-xs">
              <dt className="font-mono text-muted-foreground">{detail.label}</dt>
              <dd className="break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {state === "request" ? form : null}

      {state === "request" ? (
        <>
          {/* On a phone the answers stay at the bottom of the screen while a long card is read. */}
          <div className="flex min-h-8 flex-wrap items-center justify-end gap-2 max-md:sticky max-md:bottom-0 max-md:-mx-4 max-md:border-t max-md:bg-card max-md:px-4 max-md:py-2">
            {onDeny ? (
              <Button type="button" size="sm" variant="outline" data-action="deny" disabled={pending} onClick={onDeny}>
                Deny
              </Button>
            ) : null}
            {onAlwaysAllow ? (
              <Button type="button" size="sm" variant="outline" data-action="always" disabled={pending} onClick={onAlwaysAllow}>
                Always allow
              </Button>
            ) : null}
            {onAllowOnce ? (
              <Button type="button" size="sm" variant={destructive ? "destructive" : "default"} data-action="allow" disabled={pending} onClick={onAllowOnce}>
                Allow once
              </Button>
            ) : null}
          </div>
          {footnote ? <p className="text-xs text-muted-foreground">{footnote}</p> : null}
        </>
      ) : (
        <div role="status" className="flex min-h-8 items-center gap-2 text-sm text-muted-foreground">
          {RECEIPT_ICON[state]}
          {statusLabel ?? RECEIPT_WORD[state]}
        </div>
      )}
    </div>
  );
}
