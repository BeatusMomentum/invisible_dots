// Derived from shadcn/ui apps/v4/registry/new-york-v4/ui/label.tsx at 0e3abd65, MIT; changed: the import of cn is relative; a plain label element in place of the Radix primitive; no group or peer disabled styles.
import * as React from "react";
import { cn } from "../../lib/utils";

/** The label of a form control. */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="label" className={cn("flex items-center gap-2 text-sm leading-none font-medium select-none", className)} {...props} />;
}

export { Label };
