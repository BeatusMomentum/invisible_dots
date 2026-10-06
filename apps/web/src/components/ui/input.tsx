// Derived from shadcn/ui apps/v4/registry/new-york-v4/ui/input.tsx at 0e3abd65, MIT; changed: the import of cn is relative; the surface is the background token with no dark override; no file-input or selection styles; aria-invalid uses the danger token.
import * as React from "react";
import { cn } from "../../lib/utils";

/** A one-line text field in the look of the other form controls. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-danger aria-invalid:ring-danger/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
