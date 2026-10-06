// Derived from shadcn/ui apps/v4/registry/new-york-v4/ui/textarea.tsx at 0e3abd65, MIT; changed: the import of cn is relative; the surface is the background token with no dark override; the height does not follow the content (field-sizing is dropped); aria-invalid uses the danger token.
import * as React from "react";
import { cn } from "../../lib/utils";

/** A multi-line text field in the look of the other form controls. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-xs transition-[color,box-shadow] focus-visible:outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/80",
        "aria-invalid:border-danger aria-invalid:ring-danger/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
