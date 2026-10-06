"use client";

import type { ReactNode } from "react";
import { ErrorAlert } from "./ErrorAlert";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

/**
 * A question put before something that cannot be undone: what will happen, and a button that does it. It does not
 * close itself on a failure: the error shows in it and the person may try again or give up.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  keepLabel = "Keep it",
  destructive = false,
  pending,
  error,
  errorTitle,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  keepLabel?: string;
  destructive?: boolean;
  pending: boolean;
  error: unknown;
  errorTitle: string;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <ErrorAlert error={error} title={errorTitle} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {keepLabel}
          </Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
